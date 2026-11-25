// Authenticated, workspace-scoped API handlers. Every handler receives a context whose
// userId came from a verified Clerk token, and every workspace route resolves membership
// before touching data. Non-members receive 404 to avoid disclosing resource existence.
import { json, readJson, nowIso, newId, badRequest, notFound, conflict, forbidden, cleanString, clampInt, parseJsonColumn } from "../http.js";
import { auditStatement, audit } from "../services/audit.js";
import { enforceRateLimit } from "../services/ratelimit.js";
import { listMemberships, resolveWorkspace, requirePermission } from "../services/context.js";
import { ROLES, can, canManageRole, permissionsFor } from "../domain/rbac.js";
import { validateTaskInput, transitionTask, TASK_STATUSES } from "../domain/tasks.js";
import { validateAgentInput, canTransitionAgent, CAPABILITIES, AGENT_TYPES, AGENT_STATUSES } from "../domain/agents.js";
import { RUN_STATUSES, ACTIVE_RUN_STATUSES } from "../domain/runs.js";
import { startRun, executeRun, cancelRun, expireApprovals, hydrateAgent, hydrateRun } from "../orchestration/engine.js";
import { providerCatalogView } from "../orchestration/providers.js";
import { ADAPTERS, toolCatalogView, adapterCatalogView } from "../orchestration/tools.js";

const ID = /^[A-Za-z0-9_-]{3,80}$/;
const assertId = (value, label) => { if (!ID.test(value || "")) throw notFound(`${label} not found.`); return value; };
const TASK_COLUMNS = "id, workspace_id, title, description, status, priority, required_capability, owner_id AS created_by, created_at, updated_at";

function agentView(row) {
  const agent = hydrateAgent(row);
  return agent;
}

function connectionView(row) {
  const { scopes_json, ...rest } = row;
  return { ...rest, requires_approval: Boolean(row.requires_approval), scopes: parseJsonColumn(scopes_json, []) };
}

async function writeLimit(ctx, bucket = "write", limit = 120) {
  await enforceRateLimit(ctx.env.DB, `${bucket}:${ctx.userId}`, { limit });
}

// ---------- identity & workspaces ----------

export async function getMe(ctx) {
  const user = await ctx.env.DB.prepare("SELECT id, email, display_name, created_at FROM users WHERE id = ?").bind(ctx.userId).first();
  const workspaces = await listMemberships(ctx.env.DB, ctx.userId);
  return json({ user, session_id: ctx.sessionId, workspaces });
}

export async function createWorkspace(ctx) {
  await writeLimit(ctx, "workspace", 10);
  const body = await readJson(ctx.request);
  const name = cleanString(body.name, { field: "Workspace name", min: 2, max: 80, required: true });
  const db = ctx.env.DB;
  const timestamp = nowIso();
  const id = newId("ws");
  await db.batch([
    db.prepare("INSERT INTO workspaces (id, name, kind, created_by, created_at, updated_at) VALUES (?, ?, 'team', ?, ?, ?)").bind(id, name, ctx.userId, timestamp, timestamp),
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, added_by, created_at) VALUES (?, ?, 'owner', ?, ?)").bind(id, ctx.userId, ctx.userId, timestamp),
    auditStatement(db, { workspaceId: id, actorId: ctx.userId, action: "workspace.created", targetType: "workspace", targetId: id, metadata: { name }, correlationId: ctx.correlationId })
  ]);
  return json({ workspace: { id, name, kind: "team", role: "owner", permissions: permissionsFor("owner"), created_at: timestamp } }, 201);
}

export async function getWorkspace(ctx) {
  const ws = ctx.workspace;
  const counts = await ctx.env.DB.prepare("SELECT COUNT(*) AS members FROM workspace_members WHERE workspace_id = ?").bind(ws.id).first();
  return json({ workspace: { id: ws.id, name: ws.name, kind: ws.kind, role: ws.role, permissions: permissionsFor(ws.role), member_count: counts?.members || 0 } });
}

export async function updateWorkspace(ctx) {
  requirePermission(ctx.workspace.role, "workspace.update");
  await writeLimit(ctx);
  const body = await readJson(ctx.request);
  const name = cleanString(body.name, { field: "Workspace name", min: 2, max: 80, required: true });
  const db = ctx.env.DB;
  await db.batch([
    db.prepare("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?").bind(name, nowIso(), ctx.workspace.id),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: "workspace.renamed", targetType: "workspace", targetId: ctx.workspace.id, metadata: { from: ctx.workspace.name, to: name }, correlationId: ctx.correlationId })
  ]);
  return json({ workspace: { ...ctx.workspace, name } });
}

export async function listMembers(ctx) {
  const { results = [] } = await ctx.env.DB.prepare(
    "SELECT m.user_id, m.role, m.created_at, u.email, u.display_name FROM workspace_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at ASC"
  ).bind(ctx.workspace.id).all();
  return json({ members: results });
}

export async function addMember(ctx) {
  if (ctx.workspace.kind === "personal") throw conflict("Personal workspaces cannot have additional members. Create a team workspace.");
  await writeLimit(ctx);
  const body = await readJson(ctx.request);
  const email = cleanString(body.email, { field: "Email", min: 3, max: 254, required: true }).toLowerCase();
  const role = body.role ?? "member";
  if (!ROLES.includes(role) || role === "owner") throw badRequest("Role must be admin, member, or viewer.");
  if (!canManageRole(ctx.workspace.role, null, role)) throw forbidden();
  const db = ctx.env.DB;
  const user = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (!user) throw notFound("No ZUVANE user with that email. They must sign in once before being added.");
  const existing = await db.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(ctx.workspace.id, user.id).first();
  if (existing) throw conflict("That user is already a member.");
  await db.batch([
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, added_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(ctx.workspace.id, user.id, role, ctx.userId, nowIso()),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: "member.added", targetType: "user", targetId: user.id, metadata: { role }, correlationId: ctx.correlationId })
  ]);
  return json({ member: { user_id: user.id, email, role } }, 201);
}

async function ownerCount(db, workspaceId) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner'").bind(workspaceId).first();
  return Number(row?.n || 0);
}

export async function updateMember(ctx, { memberId }) {
  await writeLimit(ctx);
  const body = await readJson(ctx.request);
  if (!ROLES.includes(body.role)) throw badRequest("Unsupported role.");
  const db = ctx.env.DB;
  const target = await db.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(ctx.workspace.id, assertId(memberId, "Member")).first();
  if (!target) throw notFound("Member not found.");
  if (!canManageRole(ctx.workspace.role, target.role, body.role)) throw forbidden();
  if (target.role === "owner" && body.role !== "owner" && await ownerCount(db, ctx.workspace.id) <= 1) throw conflict("A workspace must keep at least one owner.");
  await db.batch([
    db.prepare("UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?").bind(body.role, ctx.workspace.id, memberId),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: "member.role_changed", targetType: "user", targetId: memberId, metadata: { from: target.role, to: body.role }, correlationId: ctx.correlationId })
  ]);
  return json({ member: { user_id: memberId, role: body.role } });
}

export async function removeMember(ctx, { memberId }) {
  await writeLimit(ctx);
  const db = ctx.env.DB;
  const target = await db.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(ctx.workspace.id, assertId(memberId, "Member")).first();
  if (!target) throw notFound("Member not found.");
  const self = memberId === ctx.userId;
  if (!self && !canManageRole(ctx.workspace.role, target.role, target.role)) throw forbidden();
  if (target.role === "owner" && await ownerCount(db, ctx.workspace.id) <= 1) throw conflict("A workspace must keep at least one owner.");
  if (ctx.workspace.kind === "personal") throw conflict("Members cannot be removed from a personal workspace.");
  await db.batch([
    db.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?").bind(ctx.workspace.id, memberId),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: self ? "member.left" : "member.removed", targetType: "user", targetId: memberId, metadata: { role: target.role }, correlationId: ctx.correlationId })
  ]);
  return json({ removed: true });
}

// ---------- overview ----------

export async function getOverview(ctx) {
  const db = ctx.env.DB;
  const ws = ctx.workspace.id;
  await expireApprovals(db, ws, { correlationId: ctx.correlationId });
  const [taskCounts, agentCounts, pending, runs, activity] = await db.batch([
    db.prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE workspace_id = ? GROUP BY status").bind(ws),
    db.prepare("SELECT status, COUNT(*) AS n FROM agents WHERE workspace_id = ? GROUP BY status").bind(ws),
    db.prepare("SELECT id, task_id, run_id, action, risk_level, requested_at, expires_at FROM approvals WHERE workspace_id = ? AND status = 'pending' ORDER BY requested_at ASC LIMIT 5").bind(ws),
    db.prepare("SELECT r.id, r.status, r.task_id, r.agent_id, r.created_at, r.finished_at, t.title AS task_title, a.name AS agent_name FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN agents a ON a.id = r.agent_id WHERE r.workspace_id = ? ORDER BY r.created_at DESC LIMIT 6").bind(ws),
    db.prepare("SELECT id, actor_type, actor_id, action, target_type, target_id, created_at FROM audit_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 8").bind(ws)
  ]);
  const toMap = (rows) => Object.fromEntries((rows.results || []).map((row) => [row.status, row.n]));
  const pendingCount = await db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE workspace_id = ? AND status = 'pending'").bind(ws).first();
  return json({
    tasks: toMap(taskCounts), agents: toMap(agentCounts),
    pending_approvals: pending.results || [], pending_approval_count: pendingCount?.n || 0,
    recent_runs: runs.results || [], recent_activity: activity.results || []
  });
}

// ---------- tasks ----------

export async function listTasks(ctx) {
  const status = ctx.url.searchParams.get("status");
  const db = ctx.env.DB;
  let statement;
  if (status && status !== "all") {
    if (!TASK_STATUSES.includes(status)) throw badRequest("Unsupported status filter.");
    statement = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE workspace_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 200`).bind(ctx.workspace.id, status);
  } else {
    statement = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 200`).bind(ctx.workspace.id);
  }
  const { results = [] } = await statement.all();
  return json({ tasks: results });
}

function parseCapability(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!CAPABILITIES.includes(value)) throw badRequest("Unsupported required capability.");
  return value;
}

export async function createTask(ctx) {
  requirePermission(ctx.workspace.role, "task.write");
  await writeLimit(ctx);
  const body = await readJson(ctx.request);
  const parsed = validateTaskInput(body);
  if (!parsed.ok) throw badRequest(parsed.error);
  const capability = parseCapability(body.required_capability);
  const timestamp = nowIso();
  const task = { id: newId("tsk"), workspace_id: ctx.workspace.id, ...parsed.value, required_capability: capability, status: "planned", created_by: ctx.userId, created_at: timestamp, updated_at: timestamp };
  const db = ctx.env.DB;
  await db.batch([
    db.prepare("INSERT INTO tasks (id, owner_id, workspace_id, title, description, status, priority, required_capability, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)")
      .bind(task.id, ctx.userId, task.workspace_id, task.title, task.description, task.priority, capability, timestamp, timestamp),
    auditStatement(db, { workspaceId: task.workspace_id, actorId: ctx.userId, action: "task.created", targetType: "task", targetId: task.id, metadata: { title: task.title, priority: task.priority }, correlationId: ctx.correlationId })
  ]);
  return json({ task }, 201);
}

async function loadTask(ctx, taskId) {
  const task = await ctx.env.DB.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ? AND workspace_id = ?`).bind(assertId(taskId, "Task"), ctx.workspace.id).first();
  if (!task) throw notFound("Task not found.");
  return task;
}

export async function getTask(ctx, { taskId }) {
  const task = await loadTask(ctx, taskId);
  const db = ctx.env.DB;
  const [runs, approvals, events] = await db.batch([
    db.prepare("SELECT r.id, r.status, r.agent_id, a.name AS agent_name, r.steps_used, r.error, r.created_at, r.finished_at FROM agent_runs r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.task_id = ? AND r.workspace_id = ? ORDER BY r.created_at DESC LIMIT 50").bind(task.id, ctx.workspace.id),
    db.prepare("SELECT id, run_id, action, params_summary, risk_level, status, requested_at, decided_by, decided_at, decision_note, execution_result FROM approvals WHERE task_id = ? AND workspace_id = ? ORDER BY requested_at DESC LIMIT 50").bind(task.id, ctx.workspace.id),
    db.prepare("SELECT id, actor_type, actor_id, action, metadata_json, created_at FROM audit_events WHERE workspace_id = ? AND target_id = ? ORDER BY created_at DESC LIMIT 50").bind(ctx.workspace.id, task.id)
  ]);
  return json({ task, runs: runs.results || [], approvals: approvals.results || [], events: (events.results || []).map(({ metadata_json, ...e }) => ({ ...e, metadata: parseJsonColumn(metadata_json, {}) })) });
}

export async function updateTask(ctx, { taskId }) {
  requirePermission(ctx.workspace.role, "task.write");
  await writeLimit(ctx);
  const task = await loadTask(ctx, taskId);
  if (task.status === "completed") throw conflict("Completed tasks cannot be edited.");
  const body = await readJson(ctx.request);
  const merged = validateTaskInput({ title: body.title ?? task.title, description: body.description ?? task.description, priority: body.priority ?? task.priority });
  if (!merged.ok) throw badRequest(merged.error);
  const capability = body.required_capability === undefined ? task.required_capability : parseCapability(body.required_capability);
  const timestamp = nowIso();
  const db = ctx.env.DB;
  await db.batch([
    db.prepare("UPDATE tasks SET title = ?, description = ?, priority = ?, required_capability = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .bind(merged.value.title, merged.value.description, merged.value.priority, capability, timestamp, task.id, ctx.workspace.id),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: "task.updated", targetType: "task", targetId: task.id, metadata: { fields: Object.keys(body) }, correlationId: ctx.correlationId })
  ]);
  return json({ task: { ...task, ...merged.value, required_capability: capability, updated_at: timestamp } });
}

export async function setTaskStatus(ctx, { taskId }) {
  requirePermission(ctx.workspace.role, "task.write");
  await writeLimit(ctx);
  const task = await loadTask(ctx, taskId);
  const body = await readJson(ctx.request);
  if (body.status === "needs_approval") throw conflict("Use the approval request endpoint to pause a task for approval.");
  if (task.status === "needs_approval") throw conflict("A task waiting for approval can only move through an approval decision.");
  const active = await ctx.env.DB.prepare(`SELECT id FROM agent_runs WHERE task_id = ? AND status IN (${ACTIVE_RUN_STATUSES.map(() => "?").join(", ")}) LIMIT 1`).bind(task.id, ...ACTIVE_RUN_STATUSES).first();
  if (active) throw conflict("This task has an active agent run. Cancel the run first.", { run_id: active.id });
  const moved = transitionTask(task, body.status);
  if (!moved.ok) throw conflict(moved.error);
  const timestamp = nowIso();
  const db = ctx.env.DB;
  const [update] = await db.batch([
    db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = ?").bind(body.status, timestamp, task.id, ctx.workspace.id, task.status),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: "task.status_changed", targetType: "task", targetId: task.id, metadata: { from: task.status, to: body.status }, correlationId: ctx.correlationId })
  ]);
  if (update.meta?.changes !== 1) throw conflict("Task changed concurrently. Refresh and retry.");
  return json({ task: { ...task, status: body.status, updated_at: timestamp } });
}

// ---------- approvals ----------

export async function listApprovals(ctx) {
  const db = ctx.env.DB;
  await expireApprovals(db, ctx.workspace.id, { correlationId: ctx.correlationId });
  const status = ctx.url.searchParams.get("status") || "pending";
  const base = "SELECT a.id, a.task_id, a.run_id, a.agent_id, a.requested_by, a.action, a.params_summary, a.risk_level, a.status, a.requested_at, a.expires_at, a.decided_by, a.decided_at, a.decision_note, a.execution_result, t.title AS task_title, g.name AS agent_name FROM approvals a LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN agents g ON g.id = a.agent_id WHERE a.workspace_id = ?";
  let statement;
  if (status === "all") statement = db.prepare(`${base} ORDER BY a.requested_at DESC LIMIT 200`).bind(ctx.workspace.id);
  else {
    if (!["pending", "approved", "rejected", "cancelled", "expired"].includes(status)) throw badRequest("Unsupported status filter.");
    statement = db.prepare(`${base} AND a.status = ? ORDER BY a.requested_at ${status === "pending" ? "ASC" : "DESC"} LIMIT 200`).bind(ctx.workspace.id, status);
  }
  const { results = [] } = await statement.all();
  return json({ approvals: results });
}

export async function requestApproval(ctx) {
  requirePermission(ctx.workspace.role, "approval.request");
  await writeLimit(ctx);
  const body = await readJson(ctx.request);
  const action = cleanString(body.action, { field: "Action", min: 3, max: 160, required: true });
  const risk = body.risk_level ?? "medium";
  if (!["low", "medium", "high", "critical"].includes(risk)) throw badRequest("Unsupported risk level.");
  const summary = cleanString(body.params_summary, { field: "Summary", max: 500 });
  const task = await loadTask(ctx, body.task_id);
  if (task.status !== "in_progress") throw conflict("Only in-progress tasks can request approval.");
  const active = await ctx.env.DB.prepare(`SELECT id FROM agent_runs WHERE task_id = ? AND status IN (${ACTIVE_RUN_STATUSES.map(() => "?").join(", ")}) LIMIT 1`).bind(task.id, ...ACTIVE_RUN_STATUSES).first();
  if (active) throw conflict("This task has an active agent run; the run manages its own approvals.");
  const timestamp = nowIso();
  const approval = { id: newId("apr"), workspace_id: ctx.workspace.id, task_id: task.id, action, params_summary: summary, risk_level: risk, status: "pending", requested_by: ctx.userId, requested_at: timestamp, expires_at: new Date(Date.now() + 72 * 3600_000).toISOString() };
  const db = ctx.env.DB;
  await db.batch([
    db.prepare("INSERT INTO approvals (id, workspace_id, task_id, requested_by, action, params_summary, risk_level, status, requested_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .bind(approval.id, approval.workspace_id, task.id, ctx.userId, action, summary, risk, timestamp, approval.expires_at),
    db.prepare("UPDATE tasks SET status = 'needs_approval', updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'in_progress'").bind(timestamp, task.id, ctx.workspace.id),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: "approval.requested", targetType: "approval", targetId: approval.id, metadata: { task_id: task.id, risk }, correlationId: ctx.correlationId })
  ]);
  return json({ approval }, 201);
}

async function loadApproval(ctx, approvalId) {
  const approval = await ctx.env.DB.prepare("SELECT * FROM approvals WHERE id = ? AND workspace_id = ?").bind(assertId(approvalId, "Approval"), ctx.workspace.id).first();
  if (!approval) throw notFound("Approval not found.");
  return approval;
}

export async function decideApproval(ctx, { approvalId }) {
  requirePermission(ctx.workspace.role, "approval.decide");
  await writeLimit(ctx);
  const db = ctx.env.DB;
  await expireApprovals(db, ctx.workspace.id, { correlationId: ctx.correlationId });
  const approval = await loadApproval(ctx, approvalId);
  const body = await readJson(ctx.request);
  if (body.decision !== "approved" && body.decision !== "rejected") throw badRequest("Decision must be approved or rejected.");
  const note = cleanString(body.note, { field: "Note", max: 500 });
  if (approval.status !== "pending") throw conflict(`Only pending approvals can be decided (this one is ${approval.status}).`);
  const timestamp = nowIso();
  const [update] = await db.batch([
    db.prepare("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'")
      .bind(body.decision, ctx.userId, timestamp, note || null, approval.id),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: `approval.${body.decision}`, targetType: "approval", targetId: approval.id, metadata: { task_id: approval.task_id, run_id: approval.run_id, risk: approval.risk_level }, correlationId: ctx.correlationId })
  ]);
  if (update.meta?.changes !== 1) throw conflict("Approval was decided concurrently.");

  let run = null;
  let taskStatus;
  if (approval.run_id) {
    const current = await db.prepare("SELECT * FROM agent_runs WHERE id = ? AND workspace_id = ?").bind(approval.run_id, ctx.workspace.id).first();
    if (current && current.status === "waiting_approval") {
      if (body.decision === "approved") {
        await db.prepare("UPDATE agent_runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'waiting_approval'").bind(timestamp, current.id).run();
        await db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'needs_approval'").bind(timestamp, approval.task_id).run();
        run = await executeRun(db, current.id, { correlationId: ctx.correlationId });
      } else {
        await db.batch([
          db.prepare("UPDATE agent_runs SET status = 'failed', error = 'Approval rejected by a workspace member.', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting_approval'").bind(timestamp, timestamp, current.id),
          db.prepare("UPDATE approvals SET execution_result = 'Not executed: rejected.' WHERE id = ?").bind(approval.id),
          db.prepare("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ? AND status = 'needs_approval'").bind(timestamp, approval.task_id)
        ]);
      }
      run = hydrateRun(await db.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(current.id).first());
    }
  } else {
    const next = body.decision === "approved" ? "in_progress" : "blocked";
    await db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'needs_approval'").bind(next, timestamp, approval.task_id, ctx.workspace.id).run();
  }
  const task = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind(approval.task_id).first();
  taskStatus = task?.status;
  return json({ approval: { ...approval, status: body.decision, decided_by: ctx.userId, decided_at: timestamp, decision_note: note || null }, task_status: taskStatus, run });
}

export async function cancelApproval(ctx, { approvalId }) {
  await writeLimit(ctx);
  const approval = await loadApproval(ctx, approvalId);
  const mayCancel = approval.requested_by === ctx.userId ? can(ctx.workspace.role, "approval.request") : can(ctx.workspace.role, "approval.decide");
  if (!mayCancel) throw forbidden();
  if (approval.status !== "pending") throw conflict(`Only pending approvals can be cancelled (this one is ${approval.status}).`);
  const db = ctx.env.DB;
  const timestamp = nowIso();
  const statements = [
    db.prepare("UPDATE approvals SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").bind(ctx.userId, timestamp, approval.id),
    db.prepare("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ? AND status = 'needs_approval'").bind(timestamp, approval.task_id),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: "approval.cancelled", targetType: "approval", targetId: approval.id, metadata: { task_id: approval.task_id }, correlationId: ctx.correlationId })
  ];
  if (approval.run_id) statements.push(db.prepare("UPDATE agent_runs SET status = 'cancelled', error = 'Approval cancelled.', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting_approval'").bind(timestamp, timestamp, approval.run_id));
  await db.batch(statements);
  return json({ approval: { ...approval, status: "cancelled", decided_by: ctx.userId, decided_at: timestamp } });
}

// ---------- agents ----------

export async function listAgents(ctx) {
  const { results = [] } = await ctx.env.DB.prepare("SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200").bind(ctx.workspace.id).all();
  return json({ agents: results.map(agentView) });
}

export async function createAgent(ctx) {
  requirePermission(ctx.workspace.role, "agent.manage");
  await writeLimit(ctx);
  const input = validateAgentInput(await readJson(ctx.request));
  const timestamp = nowIso();
  const agent = { id: newId("agt"), workspace_id: ctx.workspace.id, ...input, status: "draft", created_by: ctx.userId, created_at: timestamp, updated_at: timestamp };
  const db = ctx.env.DB;
  await db.batch([
    db.prepare("INSERT INTO agents (id, workspace_id, name, description, agent_type, provider, model, status, capabilities_json, allowed_tools_json, max_steps, timeout_ms, max_retries, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(agent.id, agent.workspace_id, agent.name, agent.description, agent.agent_type, agent.provider, agent.model, JSON.stringify(agent.capabilities), JSON.stringify(agent.allowed_tools), agent.max_steps, agent.timeout_ms, agent.max_retries, ctx.userId, timestamp, timestamp),
    auditStatement(db, { workspaceId: agent.workspace_id, actorId: ctx.userId, action: "agent.created", targetType: "agent", targetId: agent.id, metadata: { name: agent.name, capabilities: agent.capabilities, allowed_tools: agent.allowed_tools }, correlationId: ctx.correlationId })
  ]);
  return json({ agent }, 201);
}

async function loadAgent(ctx, agentId) {
  const row = await ctx.env.DB.prepare("SELECT * FROM agents WHERE id = ? AND workspace_id = ?").bind(assertId(agentId, "Agent"), ctx.workspace.id).first();
  if (!row) throw notFound("Agent not found.");
  return agentView(row);
}

export async function getAgent(ctx, { agentId }) {
  const agent = await loadAgent(ctx, agentId);
  const { results = [] } = await ctx.env.DB.prepare("SELECT r.id, r.status, r.task_id, t.title AS task_title, r.steps_used, r.error, r.created_at, r.finished_at FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.agent_id = ? AND r.workspace_id = ? ORDER BY r.created_at DESC LIMIT 50")
    .bind(agent.id, ctx.workspace.id).all();
  return json({ agent, runs: results });
}

export async function updateAgent(ctx, { agentId }) {
  requirePermission(ctx.workspace.role, "agent.manage");
  await writeLimit(ctx);
  const agent = await loadAgent(ctx, agentId);
  const input = validateAgentInput(await readJson(ctx.request), { partial: true });
  const columns = { name: "name", description: "description", agent_type: "agent_type", provider: "provider", model: "model", max_steps: "max_steps", timeout_ms: "timeout_ms", max_retries: "max_retries" };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(columns)) if (input[key] !== undefined) { sets.push(`${column} = ?`); values.push(input[key]); }
  if (input.capabilities) { sets.push("capabilities_json = ?"); values.push(JSON.stringify(input.capabilities)); }
  if (input.allowed_tools) { sets.push("allowed_tools_json = ?"); values.push(JSON.stringify(input.allowed_tools)); }
  const timestamp = nowIso();
  sets.push("updated_at = ?"); values.push(timestamp);
  const db = ctx.env.DB;
  await db.batch([
    db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`).bind(...values, agent.id, ctx.workspace.id),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: "agent.updated", targetType: "agent", targetId: agent.id, metadata: { changes: input }, correlationId: ctx.correlationId })
  ]);
  return json({ agent: { ...agent, ...input, updated_at: timestamp } });
}

export async function setAgentStatus(ctx, { agentId }) {
  requirePermission(ctx.workspace.role, "agent.manage");
  await writeLimit(ctx);
  const agent = await loadAgent(ctx, agentId);
  const body = await readJson(ctx.request);
  if (!AGENT_STATUSES.includes(body.status) || body.status === "error") throw badRequest("Unsupported agent status.");
  if (!canTransitionAgent(agent.status, body.status)) throw conflict(`Agent cannot move from ${agent.status} to ${body.status}.`);
  if (body.status === "active" && agent.capabilities.length === 0) throw conflict("Assign at least one capability before activating an agent.");
  const timestamp = nowIso();
  const db = ctx.env.DB;
  const [update] = await db.batch([
    db.prepare("UPDATE agents SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = ?").bind(body.status, timestamp, agent.id, ctx.workspace.id, agent.status),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: "agent.status_changed", targetType: "agent", targetId: agent.id, metadata: { from: agent.status, to: body.status }, correlationId: ctx.correlationId })
  ]);
  if (update.meta?.changes !== 1) throw conflict("Agent changed concurrently. Refresh and retry.");
  return json({ agent: { ...agent, status: body.status, updated_at: timestamp } });
}

// ---------- runs ----------

export async function listRuns(ctx) {
  const status = ctx.url.searchParams.get("status");
  const db = ctx.env.DB;
  const base = "SELECT r.id, r.status, r.task_id, r.agent_id, r.steps_used, r.max_steps, r.error, r.created_at, r.started_at, r.finished_at, t.title AS task_title, a.name AS agent_name FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN agents a ON a.id = r.agent_id WHERE r.workspace_id = ?";
  let statement;
  if (status && status !== "all") {
    if (!RUN_STATUSES.includes(status)) throw badRequest("Unsupported status filter.");
    statement = db.prepare(`${base} AND r.status = ? ORDER BY r.created_at DESC LIMIT 200`).bind(ctx.workspace.id, status);
  } else statement = db.prepare(`${base} ORDER BY r.created_at DESC LIMIT 200`).bind(ctx.workspace.id);
  const { results = [] } = await statement.all();
  return json({ runs: results });
}

export async function createRun(ctx) {
  requirePermission(ctx.workspace.role, "run.create");
  await writeLimit(ctx, "run", 20);
  const body = await readJson(ctx.request);
  const taskId = assertId(body.task_id, "Task");
  const agentId = body.agent_id ? assertId(body.agent_id, "Agent") : null;
  const run = await startRun(ctx.env.DB, { workspaceId: ctx.workspace.id, userId: ctx.userId, taskId, agentId, correlationId: ctx.correlationId });
  const fresh = hydrateRun(await ctx.env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(run.id).first());
  return json({ run: fresh }, 201);
}

async function loadRun(ctx, runId) {
  const row = await ctx.env.DB.prepare("SELECT * FROM agent_runs WHERE id = ? AND workspace_id = ?").bind(assertId(runId, "Run"), ctx.workspace.id).first();
  if (!row) throw notFound("Run not found.");
  return row;
}

export async function getRun(ctx, { runId }) {
  const row = await loadRun(ctx, runId);
  const db = ctx.env.DB;
  const [steps, approvals, meta] = await db.batch([
    db.prepare("SELECT id, idx, type, status, summary, detail_json, created_at FROM run_steps WHERE run_id = ? ORDER BY created_at ASC, idx ASC").bind(row.id),
    db.prepare("SELECT id, action, risk_level, status, requested_at, decided_by, decided_at, execution_result FROM approvals WHERE run_id = ? ORDER BY requested_at ASC").bind(row.id),
    db.prepare("SELECT t.title AS task_title, a.name AS agent_name, a.provider, a.model FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id LEFT JOIN agents a ON a.id = r.agent_id WHERE r.id = ?").bind(row.id)
  ]);
  return json({
    run: { ...hydrateRun(row), ...(meta.results?.[0] || {}) },
    steps: (steps.results || []).map(({ detail_json, ...s }) => ({ ...s, detail: parseJsonColumn(detail_json, {}) })),
    approvals: approvals.results || []
  });
}

export async function cancelRunHandler(ctx, { runId }) {
  requirePermission(ctx.workspace.role, "run.cancel");
  await writeLimit(ctx);
  const row = await loadRun(ctx, runId);
  await cancelRun(ctx.env.DB, row, { userId: ctx.userId, correlationId: ctx.correlationId });
  return json({ run: hydrateRun(await ctx.env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(row.id).first()) });
}

// ---------- integrations ----------

export async function listIntegrations(ctx) {
  const { results = [] } = await ctx.env.DB.prepare("SELECT * FROM tool_connections WHERE workspace_id = ? ORDER BY created_at DESC").bind(ctx.workspace.id).all();
  const usage = await ctx.env.DB.prepare("SELECT connection_id, COUNT(*) AS calls FROM usage_records WHERE workspace_id = ? AND connection_id IS NOT NULL GROUP BY connection_id").bind(ctx.workspace.id).all();
  const calls = Object.fromEntries((usage.results || []).map((row) => [row.connection_id, row.calls]));
  return json({ connections: results.map((row) => ({ ...connectionView(row), total_calls: calls[row.id] || 0 })), adapters: adapterCatalogView(), providers: providerCatalogView() });
}

export async function createIntegration(ctx) {
  requirePermission(ctx.workspace.role, "integration.manage");
  await writeLimit(ctx);
  const body = await readJson(ctx.request);
  if (!ADAPTERS[body.adapter]) throw badRequest("Unsupported adapter. Only mock adapters are available until real providers are approved.");
  const name = cleanString(body.name ?? ADAPTERS[body.adapter].label, { field: "Name", min: 2, max: 80, required: true });
  const requiresApproval = body.requires_approval === undefined ? true : Boolean(body.requires_approval);
  const rate = clampInt(body.rate_limit_per_min, { min: 1, max: 600, fallback: 30 });
  const db = ctx.env.DB;
  const timestamp = nowIso();
  const id = newId("con");
  await db.batch([
    db.prepare("INSERT INTO tool_connections (id, workspace_id, adapter, name, status, scopes_json, requires_approval, rate_limit_per_min, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?, ?)")
      .bind(id, ctx.workspace.id, body.adapter, name, JSON.stringify(adapterCatalogView().find((a) => a.id === body.adapter).tools), requiresApproval ? 1 : 0, rate, ctx.userId, timestamp, timestamp),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: "integration.connected", targetType: "integration", targetId: id, metadata: { adapter: body.adapter, requires_approval: requiresApproval, rate_limit_per_min: rate }, correlationId: ctx.correlationId })
  ]);
  return json({ connection: connectionView(await db.prepare("SELECT * FROM tool_connections WHERE id = ?").bind(id).first()) }, 201);
}

export async function updateIntegration(ctx, { connectionId }) {
  requirePermission(ctx.workspace.role, "integration.manage");
  await writeLimit(ctx);
  const db = ctx.env.DB;
  const row = await db.prepare("SELECT * FROM tool_connections WHERE id = ? AND workspace_id = ?").bind(assertId(connectionId, "Integration"), ctx.workspace.id).first();
  if (!row) throw notFound("Integration not found.");
  const body = await readJson(ctx.request);
  const status = body.status ?? row.status;
  if (!["connected", "disabled"].includes(status)) throw badRequest("Status must be connected or disabled.");
  const requiresApproval = body.requires_approval === undefined ? row.requires_approval : (body.requires_approval ? 1 : 0);
  const rate = body.rate_limit_per_min === undefined ? row.rate_limit_per_min : clampInt(body.rate_limit_per_min, { min: 1, max: 600, fallback: row.rate_limit_per_min });
  const timestamp = nowIso();
  await db.batch([
    db.prepare("UPDATE tool_connections SET status = ?, requires_approval = ?, rate_limit_per_min = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").bind(status, requiresApproval, rate, timestamp, row.id, ctx.workspace.id),
    auditStatement(db, { workspaceId: ctx.workspace.id, actorId: ctx.userId, action: "integration.updated", targetType: "integration", targetId: row.id, metadata: { status, requires_approval: Boolean(requiresApproval), rate_limit_per_min: rate }, correlationId: ctx.correlationId })
  ]);
  return json({ connection: connectionView({ ...row, status, requires_approval: requiresApproval, rate_limit_per_min: rate, updated_at: timestamp }) });
}

// ---------- activity & catalog ----------

export async function listActivity(ctx) {
  const limit = clampInt(ctx.url.searchParams.get("limit"), { min: 1, max: 200, fallback: 50 });
  const before = ctx.url.searchParams.get("before");
  const db = ctx.env.DB;
  const statement = before && !Number.isNaN(Date.parse(before))
    ? db.prepare("SELECT * FROM audit_events WHERE workspace_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?").bind(ctx.workspace.id, before, limit)
    : db.prepare("SELECT * FROM audit_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?").bind(ctx.workspace.id, limit);
  const { results = [] } = await statement.all();
  return json({ events: results.map(({ metadata_json, ...e }) => ({ ...e, metadata: parseJsonColumn(metadata_json, {}) })) });
}

export function getCatalog() {
  return json({ capabilities: CAPABILITIES, agent_types: AGENT_TYPES, agent_statuses: AGENT_STATUSES, run_statuses: RUN_STATUSES, task_statuses: TASK_STATUSES, roles: ROLES, providers: providerCatalogView(), tools: toolCatalogView(), adapters: adapterCatalogView() });
}

export { audit };
