// Bounded, deterministic orchestration engine.
// Runs execute synchronously inside the authorised request (no hidden background work),
// are capped by max_steps / timeout / max_retries, and pause on approval gates.
import { newId, nowIso, parseJsonColumn, conflict, notFound } from "../http.js";
import { auditStatement, log } from "../services/audit.js";
import { selectAgent } from "../domain/agents.js";
import { assertRunTransition, APPROVAL_TTL_MS, ACTIVE_RUN_STATUSES } from "../domain/runs.js";
import { getProvider, withTimeout } from "./providers.js";
import { TOOL_CATALOG, toolRequiresApproval, describeToolCall, executeMockTool } from "./tools.js";

export function hydrateAgent(row) {
  if (!row) return null;
  const { capabilities_json, allowed_tools_json, ...rest } = row;
  return { ...rest, capabilities: parseJsonColumn(capabilities_json, []), allowed_tools: parseJsonColumn(allowed_tools_json, []) };
}

export function hydrateRun(row) {
  if (!row) return null;
  const { input_json, plan_json, output_json, ...rest } = row;
  return { ...rest, input: parseJsonColumn(input_json, {}), plan: parseJsonColumn(plan_json, []), output: parseJsonColumn(output_json, null) };
}

const placeholders = (list) => list.map(() => "?").join(", ");

async function loadAgents(db, workspaceId) {
  const { results = [] } = await db.prepare("SELECT * FROM agents WHERE workspace_id = ?").bind(workspaceId).all();
  return results.map(hydrateAgent);
}

async function connectedAdapters(db, workspaceId) {
  const { results = [] } = await db.prepare("SELECT adapter FROM tool_connections WHERE workspace_id = ? AND status = 'connected'").bind(workspaceId).all();
  return new Set(results.map((row) => row.adapter));
}

function stepStatement(db, run, idx, type, status, summary, detail = {}) {
  return db.prepare("INSERT INTO run_steps (id, run_id, workspace_id, idx, type, status, summary, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(newId("stp"), run.id, run.workspace_id, idx, type, status, summary.slice(0, 500), JSON.stringify(detail), nowIso());
}

async function setRunStatus(db, run, next, fields = {}) {
  assertRunTransition(run.status, next);
  const timestamp = nowIso();
  const sets = ["status = ?", "updated_at = ?"];
  const values = [next, timestamp];
  for (const [key, value] of Object.entries(fields)) { sets.push(`${key} = ?`); values.push(value); }
  const result = await db.prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id = ? AND status = ?`).bind(...values, run.id, run.status).run();
  if (!result.meta || result.meta.changes !== 1) throw conflict("Run state changed concurrently. Refresh and retry.");
  Object.assign(run, fields, { status: next, updated_at: timestamp });
  return run;
}

async function moveTask(db, taskId, from, to) {
  await db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders(from)})`)
    .bind(to, nowIso(), taskId, ...from).run();
}

async function failRun(db, run, message, ctx) {
  await setRunStatus(db, run, "failed", { error: message.slice(0, 500), finished_at: nowIso() });
  await moveTask(db, run.task_id, ["in_progress", "needs_approval"], "blocked");
  await auditStatement(db, { workspaceId: run.workspace_id, actorType: "system", actorId: "orchestrator", action: "run.failed", targetType: "run", targetId: run.id, metadata: { error: message, task_id: run.task_id }, correlationId: ctx.correlationId }).run();
  log("warn", "run failed", { runId: run.id, correlationId: ctx.correlationId, error: message });
  return run;
}

async function recentConnectionUsage(db, connectionId) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE connection_id = ? AND created_at > ?").bind(connectionId, since).first();
  return Number(row?.n || 0);
}

/** Creates a run for a task, selects an agent by capability, plans and executes it. */
export async function startRun(db, { workspaceId, userId, taskId, agentId, correlationId }) {
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?").bind(taskId, workspaceId).first();
  if (!task) throw notFound("Task not found.");
  if (!["planned", "in_progress", "blocked"].includes(task.status)) throw conflict(`A run cannot start while the task is ${task.status}.`);
  const active = await db.prepare(`SELECT id FROM agent_runs WHERE task_id = ? AND status IN (${placeholders(ACTIVE_RUN_STATUSES)}) LIMIT 1`)
    .bind(task.id, ...ACTIVE_RUN_STATUSES).first();
  if (active) throw conflict("This task already has an active run.", { run_id: active.id });

  const agents = await loadAgents(db, workspaceId);
  let agent;
  let reason;
  if (agentId) {
    agent = agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw notFound("Agent not found.");
    if (agent.status !== "active") throw conflict(`Agent is ${agent.status}. Only active agents can run.`);
    if (task.required_capability && !agent.capabilities.includes(task.required_capability)) {
      throw conflict(`Agent lacks the required capability "${task.required_capability}".`);
    }
    reason = "Explicitly assigned by a workspace member.";
  } else {
    agent = selectAgent(agents, task.required_capability);
    if (!agent) throw conflict(task.required_capability ? `No active agent has the "${task.required_capability}" capability.` : "No active agent is available in this workspace.");
    reason = task.required_capability ? `Matched capability "${task.required_capability}" (most specialised active agent).` : "First eligible active agent (deterministic order).";
  }
  const provider = getProvider(agent.provider);
  if (!provider) throw conflict("The agent's provider is not configured.");

  const adapters = await connectedAdapters(db, workspaceId);
  const grantedTools = agent.allowed_tools.filter((tool) => TOOL_CATALOG[tool] && adapters.has(TOOL_CATALOG[tool].adapter));
  const plan = provider.plan({ task, allowedTools: grantedTools });
  const timestamp = nowIso();
  const run = {
    id: newId("run"), workspace_id: workspaceId, task_id: task.id, agent_id: agent.id, status: "queued",
    selection_reason: reason, cursor: 0, steps_used: 0, max_steps: agent.max_steps, attempt: 0,
    max_retries: agent.max_retries, timeout_ms: agent.timeout_ms, requested_by: userId, correlation_id: correlationId
  };
  await db.batch([
    db.prepare("INSERT INTO agent_runs (id, workspace_id, task_id, agent_id, status, selection_reason, input_json, plan_json, cursor, steps_used, max_steps, attempt, max_retries, timeout_ms, output_json, requested_by, correlation_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?)")
      .bind(run.id, workspaceId, task.id, agent.id, reason, JSON.stringify({ task_title: task.title, granted_tools: grantedTools }), JSON.stringify(plan), agent.max_steps, agent.max_retries, agent.timeout_ms, JSON.stringify({ tool_results: [] }), userId, correlationId, timestamp, timestamp),
    db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status IN ('planned', 'blocked')").bind(timestamp, task.id),
    auditStatement(db, { workspaceId, actorId: userId, action: "run.queued", targetType: "run", targetId: run.id, metadata: { task_id: task.id, agent_id: agent.id, plan_steps: plan.length }, correlationId })
  ]);
  await setRunStatus(db, run, "assigned");
  await auditStatement(db, { workspaceId, actorType: "system", actorId: "orchestrator", action: "run.assigned", targetType: "run", targetId: run.id, metadata: { agent_id: agent.id, reason }, correlationId }).run();
  if (plan.length > agent.max_steps) {
    return failRun(db, run, `Plan requires ${plan.length} steps but the agent is limited to ${agent.max_steps}.`, { correlationId });
  }
  return executeRun(db, run.id, { correlationId });
}

/** Executes (or resumes) a run until it completes, fails, or waits for approval. */
export async function executeRun(db, runId, ctx = {}) {
  const run = await db.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(runId).first();
  if (!run) throw notFound("Run not found.");
  const agent = hydrateAgent(await db.prepare("SELECT * FROM agents WHERE id = ? AND workspace_id = ?").bind(run.agent_id, run.workspace_id).first());
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?").bind(run.task_id, run.workspace_id).first();
  if (run.status === "assigned") await setRunStatus(db, run, "running", { started_at: nowIso() });
  if (run.status !== "running") return run;
  if (!agent || !task) return failRun(db, run, "The agent or task no longer exists.", ctx);
  if (agent.status !== "active") return failRun(db, run, `Agent became ${agent.status} during execution.`, ctx);
  const provider = getProvider(agent.provider);
  if (!provider) return failRun(db, run, "The agent's provider is not configured.", ctx);

  const plan = parseJsonColumn(run.plan_json, []);
  const context = parseJsonColumn(run.output_json, { tool_results: [] }) || { tool_results: [] };
  context.tool_results = context.tool_results || [];
  let cursor = run.cursor;
  let stepsUsed = run.steps_used;
  let lastModel = context.last_model || null;

  while (cursor < plan.length) {
    if (stepsUsed >= run.max_steps) return failRun(db, run, `Step budget of ${run.max_steps} exhausted.`, ctx);
    const step = plan[cursor];
    if (step.type === "model") {
      let result = null;
      let lastError = "";
      const maxAttempts = run.max_retries + 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          result = await withTimeout(provider.invoke({ action: step.action, task, attempt, timeoutMs: run.timeout_ms, context }), run.timeout_ms, `Provider call exceeded ${run.timeout_ms} ms.`);
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : "Provider error.";
          const willRetry = attempt < maxAttempts && error?.retryable !== false;
          await stepStatement(db, run, cursor, "model", willRetry ? "retrying" : "failed", `${step.action}: ${lastError}`, { attempt }).run();
          if (!willRetry) break;
        }
      }
      if (!result) return failRun(db, run, `Model step "${step.action}" failed: ${lastError}`, ctx);
      lastModel = result;
      context.last_model = { summary: result.summary, text: result.text || null };
      await db.batch([
        stepStatement(db, run, cursor, "model", "completed", result.summary, { action: step.action, provider: agent.provider, model: agent.model }),
        db.prepare("INSERT INTO usage_records (id, workspace_id, run_id, connection_id, provider, metric, quantity, created_at) VALUES (?, ?, ?, NULL, ?, 'tokens', ?, ?)")
          .bind(newId("use"), run.workspace_id, run.id, agent.provider, Number(result.tokens || 0), nowIso())
      ]);
    } else if (step.type === "tool") {
      const tool = TOOL_CATALOG[step.tool];
      if (!tool || !agent.allowed_tools.includes(step.tool)) {
        await auditStatement(db, { workspaceId: run.workspace_id, actorType: "agent", actorId: agent.id, action: "tool.denied", targetType: "run", targetId: run.id, metadata: { tool: step.tool }, correlationId: ctx.correlationId }).run();
        await stepStatement(db, run, cursor, "tool", "failed", `Permission denied for tool ${step.tool}.`).run();
        return failRun(db, run, `Agent is not permitted to use tool "${step.tool}".`, ctx);
      }
      const connection = await db.prepare("SELECT * FROM tool_connections WHERE workspace_id = ? AND adapter = ? AND status = 'connected' ORDER BY created_at LIMIT 1")
        .bind(run.workspace_id, tool.adapter).first();
      if (!connection) return failRun(db, run, `No connected integration for adapter "${tool.adapter}".`, ctx);
      let approval = null;
      if (toolRequiresApproval(step.tool, connection)) {
        approval = await db.prepare("SELECT * FROM approvals WHERE run_id = ? AND step_index = ? ORDER BY requested_at DESC LIMIT 1").bind(run.id, cursor).first();
        if (!approval || approval.status !== "approved") {
          if (approval && approval.status !== "pending") return failRun(db, run, `Approval was ${approval.status}.`, ctx);
          if (!approval) {
            const described = describeToolCall(step.tool, task);
            const requestedAt = nowIso();
            const approvalId = newId("apr");
            await db.batch([
              db.prepare("INSERT INTO approvals (id, workspace_id, task_id, run_id, agent_id, requested_by, action, params_summary, risk_level, status, step_index, requested_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)")
                .bind(approvalId, run.workspace_id, task.id, run.id, agent.id, run.requested_by, described.action, described.params_summary, tool.risk, cursor, requestedAt, new Date(Date.now() + APPROVAL_TTL_MS).toISOString()),
              stepStatement(db, run, cursor, "approval", "waiting", `Waiting for approval: ${described.action}`, { tool: step.tool, approval_id: approvalId }),
              db.prepare("UPDATE agent_runs SET cursor = ?, steps_used = ?, output_json = ?, approval_id = ?, updated_at = ? WHERE id = ?")
                .bind(cursor, stepsUsed, JSON.stringify(context), approvalId, requestedAt, run.id),
              db.prepare("UPDATE tasks SET status = 'needs_approval', updated_at = ? WHERE id = ? AND status = 'in_progress'").bind(requestedAt, task.id),
              auditStatement(db, { workspaceId: run.workspace_id, actorType: "agent", actorId: agent.id, action: "approval.requested", targetType: "approval", targetId: approvalId, metadata: { run_id: run.id, tool: step.tool, risk: tool.risk }, correlationId: ctx.correlationId })
            ]);
            run.approval_id = approvalId;
          }
          await setRunStatus(db, run, "waiting_approval");
          return run;
        }
      }
      if (await recentConnectionUsage(db, connection.id) >= connection.rate_limit_per_min) {
        return failRun(db, run, `Integration "${connection.name}" rate limit of ${connection.rate_limit_per_min}/min reached.`, ctx);
      }
      let toolResult;
      try {
        toolResult = await withTimeout(Promise.resolve().then(() => executeMockTool(step.tool, task)), run.timeout_ms, "Tool call timed out.");
      } catch (error) {
        await stepStatement(db, run, cursor, "tool", "failed", `${step.tool}: ${error.message}`).run();
        return failRun(db, run, `Tool "${step.tool}" failed: ${error.message}`, ctx);
      }
      context.tool_results.push(toolResult);
      const statements = [
        stepStatement(db, run, cursor, "tool", "completed", toolResult.summary, { tool: step.tool, adapter: tool.adapter, connection_id: connection.id, simulated: true }),
        db.prepare("INSERT INTO usage_records (id, workspace_id, run_id, connection_id, provider, metric, quantity, created_at) VALUES (?, ?, ?, ?, ?, 'tool_call', 1, ?)")
          .bind(newId("use"), run.workspace_id, run.id, connection.id, tool.adapter, nowIso()),
        auditStatement(db, { workspaceId: run.workspace_id, actorType: "agent", actorId: agent.id, action: "tool.executed", targetType: "run", targetId: run.id, metadata: { tool: step.tool, adapter: tool.adapter, simulated: true, approval_id: approval?.id || null }, correlationId: ctx.correlationId })
      ];
      if (approval) statements.push(db.prepare("UPDATE approvals SET execution_result = ? WHERE id = ?").bind(toolResult.summary, approval.id));
      await db.batch(statements);
    } else {
      return failRun(db, run, `Unknown plan step type "${step.type}".`, ctx);
    }
    cursor += 1;
    stepsUsed += 1;
    await db.prepare("UPDATE agent_runs SET cursor = ?, steps_used = ?, output_json = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .bind(cursor, stepsUsed, JSON.stringify(context), nowIso(), run.id).run();
    run.cursor = cursor;
    run.steps_used = stepsUsed;
  }

  const output = { summary: lastModel?.summary || "Run completed.", text: lastModel?.text || context.last_model?.text || null, tool_results: context.tool_results, simulated: true };
  await setRunStatus(db, run, "completed", { output_json: JSON.stringify(output), finished_at: nowIso() });
  await db.batch([
    db.prepare("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'in_progress'").bind(nowIso(), run.task_id),
    auditStatement(db, { workspaceId: run.workspace_id, actorType: "system", actorId: "orchestrator", action: "run.completed", targetType: "run", targetId: run.id, metadata: { steps: stepsUsed, task_id: run.task_id }, correlationId: ctx.correlationId })
  ]);
  return run;
}

/** Cancels an active run and any pending approvals attached to it. */
export async function cancelRun(db, run, { userId, correlationId }) {
  if (!ACTIVE_RUN_STATUSES.includes(run.status)) throw conflict(`Run is already ${run.status}.`);
  await setRunStatus(db, run, "cancelled", { finished_at: nowIso(), error: "Cancelled by a workspace member." });
  const timestamp = nowIso();
  await db.batch([
    db.prepare("UPDATE approvals SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE run_id = ? AND status = 'pending'").bind(userId, timestamp, run.id),
    db.prepare("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ? AND status IN ('in_progress', 'needs_approval')").bind(timestamp, run.task_id),
    auditStatement(db, { workspaceId: run.workspace_id, actorId: userId, action: "run.cancelled", targetType: "run", targetId: run.id, metadata: { task_id: run.task_id }, correlationId })
  ]);
  return run;
}

/** Marks overdue pending approvals as expired and stops what was waiting on them. */
export async function expireApprovals(db, workspaceId, { correlationId } = {}) {
  const timestamp = nowIso();
  const overdue = "SELECT {col} FROM approvals WHERE workspace_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?";
  const results = await db.batch([
    db.prepare(`UPDATE agent_runs SET status = 'failed', error = 'Approval expired before a decision was made.', finished_at = ?, updated_at = ? WHERE workspace_id = ? AND status = 'waiting_approval' AND id IN (${overdue.replace("{col}", "run_id")})`)
      .bind(timestamp, timestamp, workspaceId, workspaceId, timestamp),
    db.prepare(`UPDATE tasks SET status = 'blocked', updated_at = ? WHERE workspace_id = ? AND status = 'needs_approval' AND id IN (${overdue.replace("{col}", "task_id")})`)
      .bind(timestamp, workspaceId, workspaceId, timestamp),
    db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE workspace_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?")
      .bind(timestamp, workspaceId, timestamp)
  ]);
  const expired = results[2]?.meta?.changes || 0;
  if (expired > 0) {
    await auditStatement(db, { workspaceId, actorType: "system", actorId: "orchestrator", action: "approval.expired", metadata: { count: expired }, correlationId }).run();
  }
  return expired;
}
