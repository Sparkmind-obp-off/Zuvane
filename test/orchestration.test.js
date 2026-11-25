import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./helpers/harness.js";
import { selectAgent, validateAgentInput, canTransitionAgent } from "../src/domain/agents.js";
import { canTransitionRun } from "../src/domain/runs.js";
import { can } from "../src/domain/rbac.js";

test("agent validation defaults to least privilege and rejects unknown tools/providers", () => {
  const agent = validateAgentInput({ name: "Researcher" });
  assert.deepEqual(agent.allowed_tools, []);
  assert.deepEqual(agent.capabilities, []);
  assert.equal(agent.provider, "mock");
  assert.throws(() => validateAgentInput({ name: "X1", allowed_tools: ["shell.exec"] }));
  assert.throws(() => validateAgentInput({ name: "X1", provider: "openai" }), /not available/);
  assert.throws(() => validateAgentInput({ name: "X1", max_steps: 999 }));
});

test("agent and run state machines are bounded", () => {
  assert.equal(canTransitionAgent("draft", "active"), true);
  assert.equal(canTransitionAgent("disabled", "active"), false);
  assert.equal(canTransitionRun("completed", "running"), false);
  assert.equal(canTransitionRun("waiting_approval", "running"), true);
  assert.equal(can("viewer", "task.write"), false);
  assert.equal(can("owner", "unknown.permission"), false);
});

test("deterministic capability matching picks the most specialised active agent", () => {
  const agents = [
    { id: "a", name: "Generalist", status: "active", capabilities: ["research", "drafting", "review"] },
    { id: "b", name: "Specialist", status: "active", capabilities: ["research"] },
    { id: "c", name: "Paused", status: "paused", capabilities: ["research"] }
  ];
  assert.equal(selectAgent(agents, "research").id, "b");
  assert.equal(selectAgent(agents, "operations"), null);
});

async function setup(h, agentInput = {}) {
  const ws = await h.personalWorkspace("user_alice");
  const agent = await h.call("user_alice", "POST", `/api/workspaces/${ws}/agents`, { name: "Research agent", capabilities: ["research"], allowed_tools: ["web.search", "email.send"], ...agentInput });
  assert.equal(agent.status, 201);
  assert.equal(agent.data.agent.status, "draft");
  return { ws, agentId: agent.data.agent.id };
}

const activate = (h, ws, id) => h.call("user_alice", "POST", `/api/workspaces/${ws}/agents/${id}/status`, { status: "active" });
const task = async (h, ws, title, extra = {}) => (await h.call("user_alice", "POST", `/api/workspaces/${ws}/tasks`, { title, required_capability: "research", ...extra })).data.task.id;

test("draft agents never run; runs need an active agent with the capability", async () => {
  const h = await createHarness();
  try {
    const { ws, agentId } = await setup(h);
    const t = await task(h, ws, "Research competitors");
    const blocked = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: t });
    assert.equal(blocked.status, 409);
    assert.equal((await activate(h, ws, agentId)).status, 200);
    const t2 = await task(h, ws, "Ops work", { required_capability: "operations" });
    assert.equal((await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: t2 })).status, 409);
  } finally { h.restore(); }
});

test("full run lifecycle without tool connection: tools are not granted, run completes", async () => {
  const h = await createHarness();
  try {
    const { ws, agentId } = await setup(h);
    await activate(h, ws, agentId);
    const t = await task(h, ws, "Research the market");
    const run = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: t });
    assert.equal(run.status, 201);
    assert.equal(run.data.run.status, "completed");
    assert.deepEqual(run.data.run.input.granted_tools, []);
    assert.equal(run.data.run.output.simulated, true);
    const detail = await h.call("user_alice", "GET", `/api/workspaces/${ws}/runs/${run.data.run.id}`);
    assert.deepEqual(detail.data.steps.map((s) => s.type), ["model", "model"]);
    const taskDetail = await h.call("user_alice", "GET", `/api/workspaces/${ws}/tasks/${t}`);
    assert.equal(taskDetail.data.task.status, "completed");
  } finally { h.restore(); }
});

test("high-impact tool pauses for approval; approval resumes and executes; rejection fails run", async () => {
  const h = await createHarness();
  try {
    const { ws, agentId } = await setup(h);
    await activate(h, ws, agentId);
    for (const adapter of ["mock.web", "mock.email"]) {
      const c = await h.call("user_alice", "POST", `/api/workspaces/${ws}/integrations`, { adapter, requires_approval: false });
      assert.equal(c.status, 201);
    }
    const t = await task(h, ws, "Research leads and send email summary");
    const run = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: t });
    assert.equal(run.data.run.status, "waiting_approval");
    // web.search (low risk, policy off) executed; email.send waits.
    const pending = await h.call("user_alice", "GET", `/api/workspaces/${ws}/approvals`);
    assert.equal(pending.data.approvals.length, 1);
    const approval = pending.data.approvals[0];
    assert.equal(approval.risk_level, "high");
    assert.equal(approval.run_id, run.data.run.id);
    assert.equal((await h.call("user_alice", "GET", `/api/workspaces/${ws}/tasks/${t}`)).data.task.status, "needs_approval");
    // Manual status changes are refused while waiting.
    assert.equal((await h.call("user_alice", "PATCH", `/api/workspaces/${ws}/tasks/${t}/status`, { status: "completed" })).status, 409);
    const decided = await h.call("user_alice", "POST", `/api/workspaces/${ws}/approvals/${approval.id}/decision`, { decision: "approved" });
    assert.equal(decided.status, 200);
    assert.equal(decided.data.run.status, "completed");
    assert.equal(decided.data.task_status, "completed");
    const tools = decided.data.run.output.tool_results.map((r) => r.tool);
    assert.deepEqual(tools, ["web.search", "email.send"]);
    const all = await h.call("user_alice", "GET", `/api/workspaces/${ws}/approvals?status=all`);
    assert.match(all.data.approvals[0].execution_result, /No message was sent/);

    const t2 = await task(h, ws, "Send email to the board");
    const run2 = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: t2 });
    const ap2 = (await h.call("user_alice", "GET", `/api/workspaces/${ws}/approvals`)).data.approvals[0];
    const rej = await h.call("user_alice", "POST", `/api/workspaces/${ws}/approvals/${ap2.id}/decision`, { decision: "rejected" });
    assert.equal(rej.data.run.status, "failed");
    assert.equal(rej.data.task_status, "blocked");
    const runDetail = await h.call("user_alice", "GET", `/api/workspaces/${ws}/runs/${run2.data.run.id}`);
    assert.ok(!runDetail.data.steps.some((s) => s.type === "tool" && s.status === "completed" && s.detail.tool === "email.send"));
    const activity = await h.call("user_alice", "GET", `/api/workspaces/${ws}/activity?limit=200`);
    const actions = activity.data.events.map((e) => e.action);
    for (const a of ["agent.created", "integration.connected", "run.queued", "approval.requested", "approval.approved", "tool.executed", "run.completed", "approval.rejected"]) assert.ok(actions.includes(a), `missing ${a}`);
  } finally { h.restore(); }
});

test("tools the agent is not permitted to use are never executed", async () => {
  const h = await createHarness();
  try {
    const { ws, agentId } = await setup(h, { allowed_tools: [] });
    await activate(h, ws, agentId);
    await h.call("user_alice", "POST", `/api/workspaces/${ws}/integrations`, { adapter: "mock.email" });
    const t = await task(h, ws, "Research then [mock:tool=email.send]");
    const run = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: t });
    assert.equal(run.data.run.status, "failed");
    assert.match(run.data.run.error, /not permitted/);
    const activity = await h.call("user_alice", "GET", `/api/workspaces/${ws}/activity`);
    assert.ok(activity.data.events.some((e) => e.action === "tool.denied"));
    assert.ok(!activity.data.events.some((e) => e.action === "tool.executed"));
  } finally { h.restore(); }
});

test("retry limits, permanent failure, timeout and step budget are enforced", async () => {
  const h = await createHarness();
  try {
    const { ws, agentId } = await setup(h, { max_retries: 1, timeout_ms: 150 });
    await activate(h, ws, agentId);
    const once = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: await task(h, ws, "Research [mock:fail-once]") });
    assert.equal(once.data.run.status, "completed");
    const always = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: await task(h, ws, "Research [mock:fail]") });
    assert.equal(always.data.run.status, "failed");
    const steps = (await h.call("user_alice", "GET", `/api/workspaces/${ws}/runs/${always.data.run.id}`)).data.steps;
    assert.equal(steps.filter((s) => s.status === "retrying").length, 1);
    assert.equal(steps.filter((s) => s.status === "failed").length, 1);
    const slow = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: await task(h, ws, "Research [mock:slow]") });
    assert.equal(slow.data.run.status, "failed");
    assert.match(slow.data.run.error, /exceeded 150 ms/);

    const tight = await h.call("user_alice", "POST", `/api/workspaces/${ws}/agents`, { name: "Tight agent", capabilities: ["drafting"], allowed_tools: ["document.draft", "notes.search"], max_steps: 2 });
    await activate(h, ws, tight.data.agent.id);
    await h.call("user_alice", "POST", `/api/workspaces/${ws}/integrations`, { adapter: "mock.workspace", requires_approval: false });
    const budget = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: await task(h, ws, "Draft report from notes", { required_capability: "drafting" }) });
    assert.equal(budget.data.run.status, "failed");
    assert.match(budget.data.run.error, /limited to 2/);
  } finally { h.restore(); }
});

test("a task cannot have two active runs; cancelling a waiting run cancels its approval", async () => {
  const h = await createHarness();
  try {
    const { ws, agentId } = await setup(h);
    await activate(h, ws, agentId);
    await h.call("user_alice", "POST", `/api/workspaces/${ws}/integrations`, { adapter: "mock.email" });
    const t = await task(h, ws, "Research and send email");
    const run = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: t });
    assert.equal(run.data.run.status, "waiting_approval");
    assert.equal((await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: t })).status, 409);
    const cancelled = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs/${run.data.run.id}/cancel`);
    assert.equal(cancelled.data.run.status, "cancelled");
    const approvals = await h.call("user_alice", "GET", `/api/workspaces/${ws}/approvals?status=cancelled`);
    assert.equal(approvals.data.approvals.length, 1);
    assert.equal((await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs/${run.data.run.id}/cancel`)).status, 409);
  } finally { h.restore(); }
});

test("agents cannot be activated without capabilities; paused agents are not selected", async () => {
  const h = await createHarness();
  try {
    const { ws } = await setup(h);
    const bare = await h.call("user_alice", "POST", `/api/workspaces/${ws}/agents`, { name: "Bare" });
    assert.equal((await activate(h, ws, bare.data.agent.id)).status, 409);
    const upd = await h.call("user_alice", "PATCH", `/api/workspaces/${ws}/agents/${bare.data.agent.id}`, { capabilities: ["review"], description: "Reviews work" });
    assert.equal(upd.status, 200);
    assert.equal((await activate(h, ws, bare.data.agent.id)).status, 200);
    assert.equal((await h.call("user_alice", "POST", `/api/workspaces/${ws}/agents/${bare.data.agent.id}/status`, { status: "paused" })).status, 200);
    const r = await h.call("user_alice", "POST", `/api/workspaces/${ws}/runs`, { task_id: await task(h, ws, "Review doc", { required_capability: "review" }) });
    assert.equal(r.status, 409);
  } finally { h.restore(); }
});
