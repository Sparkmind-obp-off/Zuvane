import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./helpers/harness.js";

test("personal workspace provisioning is idempotent", async () => {
  const h = await createHarness();
  try {
    const a = await h.personalWorkspace("user_alice");
    const b = await h.personalWorkspace("user_alice");
    assert.equal(a, b);
    const count = h.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE created_by = 'user_alice'").get().n;
    assert.equal(count, 1);
  } finally { h.restore(); }
});

test("User A cannot read or mutate User B's workspace resources (IDOR)", async () => {
  const h = await createHarness();
  try {
    const wsA = await h.personalWorkspace("user_alice");
    const wsB = await h.personalWorkspace("user_bob");
    const created = await h.call("user_bob", "POST", `/api/workspaces/${wsB}/tasks`, { title: "Bob private task" });
    assert.equal(created.status, 201);
    const taskId = created.data.task.id;

    for (const [method, path, body] of [
      ["GET", `/api/workspaces/${wsB}`],
      ["GET", `/api/workspaces/${wsB}/tasks`],
      ["GET", `/api/workspaces/${wsB}/tasks/${taskId}`],
      ["PATCH", `/api/workspaces/${wsB}/tasks/${taskId}/status`, { status: "in_progress" }],
      ["POST", `/api/workspaces/${wsB}/tasks`, { title: "Injected" }],
      ["GET", `/api/workspaces/${wsB}/activity`],
      ["GET", `/api/workspaces/${wsB}/agents`]
    ]) {
      const res = await h.call("user_alice", method, path, body);
      assert.equal(res.status, 404, `${method} ${path} must not be accessible`);
    }
    // Using own workspace id with a foreign task id is also not found.
    const cross = await h.call("user_alice", "GET", `/api/workspaces/${wsA}/tasks/${taskId}`);
    assert.equal(cross.status, 404);
    const own = await h.call("user_alice", "GET", `/api/workspaces/${wsA}/tasks`);
    assert.deepEqual(own.data.tasks, []);
    // Client-supplied owner/workspace fields are ignored.
    const spoof = await h.call("user_alice", "POST", `/api/workspaces/${wsA}/tasks`, { title: "Spoof", workspace_id: wsB, owner_id: "user_bob" });
    assert.equal(spoof.data.task.workspace_id, wsA);
    assert.equal(spoof.data.task.created_by, "user_alice");
  } finally { h.restore(); }
});

test("roles are enforced: viewer read-only, member cannot decide approvals or manage agents", async () => {
  const h = await createHarness();
  try {
    await h.personalWorkspace("user_bob");
    await h.personalWorkspace("user_carol");
    h.env.DB.raw.exec("UPDATE users SET email = 'bob@example.test' WHERE id = 'user_bob'; UPDATE users SET email = 'carol@example.test' WHERE id = 'user_carol';");
    const team = await h.call("user_alice", "POST", "/api/workspaces", { name: "Ops team" });
    assert.equal(team.status, 201);
    const ws = team.data.workspace.id;
    assert.equal((await h.call("user_alice", "POST", `/api/workspaces/${ws}/members`, { email: "bob@example.test", role: "member" })).status, 201);
    assert.equal((await h.call("user_alice", "POST", `/api/workspaces/${ws}/members`, { email: "carol@example.test", role: "viewer" })).status, 201);

    // viewer
    assert.equal((await h.call("user_carol", "GET", `/api/workspaces/${ws}/tasks`)).status, 200);
    assert.equal((await h.call("user_carol", "POST", `/api/workspaces/${ws}/tasks`, { title: "Viewer task" })).status, 403);
    // member
    const task = await h.call("user_bob", "POST", `/api/workspaces/${ws}/tasks`, { title: "Member task" });
    assert.equal(task.status, 201);
    assert.equal((await h.call("user_bob", "POST", `/api/workspaces/${ws}/agents`, { name: "Rogue", capabilities: ["research"] })).status, 403);
    await h.call("user_bob", "PATCH", `/api/workspaces/${ws}/tasks/${task.data.task.id}/status`, { status: "in_progress" });
    const approval = await h.call("user_bob", "POST", `/api/workspaces/${ws}/approvals`, { task_id: task.data.task.id, action: "Publish report", risk_level: "high" });
    assert.equal(approval.status, 201);
    assert.equal((await h.call("user_bob", "POST", `/api/workspaces/${ws}/approvals/${approval.data.approval.id}/decision`, { decision: "approved" })).status, 403);
    // member cannot promote themselves
    assert.equal((await h.call("user_bob", "PATCH", `/api/workspaces/${ws}/members/user_bob`, { role: "owner" })).status, 403);
    // owner decides
    const decided = await h.call("user_alice", "POST", `/api/workspaces/${ws}/approvals/${approval.data.approval.id}/decision`, { decision: "approved", note: "OK" });
    assert.equal(decided.status, 200);
    assert.equal(decided.data.task_status, "in_progress");
    assert.equal(decided.data.approval.decided_by, "user_alice");
    // last owner cannot be demoted
    assert.equal((await h.call("user_alice", "PATCH", `/api/workspaces/${ws}/members/user_alice`, { role: "admin" })).status, 409);
    // removed member loses access
    assert.equal((await h.call("user_alice", "DELETE", `/api/workspaces/${ws}/members/user_bob`)).status, 200);
    assert.equal((await h.call("user_bob", "GET", `/api/workspaces/${ws}/tasks`)).status, 404);
  } finally { h.restore(); }
});

test("task lifecycle guards and audit trail", async () => {
  const h = await createHarness();
  try {
    const ws = await h.personalWorkspace("user_alice");
    assert.equal((await h.call("user_alice", "POST", `/api/workspaces/${ws}/tasks`, { title: "x" })).status, 400);
    assert.equal((await h.call("user_alice", "POST", `/api/workspaces/${ws}/tasks`, { title: "Valid", required_capability: "hacking" })).status, 400);
    const t = await h.call("user_alice", "POST", `/api/workspaces/${ws}/tasks`, { title: "<script>alert(1)</script>", priority: "high" });
    assert.equal(t.status, 201);
    const id = t.data.task.id;
    assert.equal((await h.call("user_alice", "PATCH", `/api/workspaces/${ws}/tasks/${id}/status`, { status: "completed" })).status, 409);
    assert.equal((await h.call("user_alice", "PATCH", `/api/workspaces/${ws}/tasks/${id}/status`, { status: "in_progress" })).status, 200);
    assert.equal((await h.call("user_alice", "PATCH", `/api/workspaces/${ws}/tasks/${id}/status`, { status: "needs_approval" })).status, 409);
    assert.equal((await h.call("user_alice", "PATCH", `/api/workspaces/${ws}/tasks/${id}/status`, { status: "completed" })).status, 200);
    const detail = await h.call("user_alice", "GET", `/api/workspaces/${ws}/tasks/${id}`);
    assert.equal(detail.data.task.title, "<script>alert(1)</script>");
    const actions = detail.data.events.map((e) => e.action);
    assert.ok(actions.includes("task.created"));
    assert.equal(actions.filter((a) => a === "task.status_changed").length, 2);
    // malformed JSON body
    const bad = await h.call("user_alice", "POST", `/api/workspaces/${ws}/tasks`, undefined, { "content-type": "application/json" });
    assert.equal(bad.status, 400);
  } finally { h.restore(); }
});

test("approval reject, cancel and expiry", async () => {
  const h = await createHarness();
  try {
    const ws = await h.personalWorkspace("user_alice");
    const mk = async (title) => {
      const t = await h.call("user_alice", "POST", `/api/workspaces/${ws}/tasks`, { title });
      await h.call("user_alice", "PATCH", `/api/workspaces/${ws}/tasks/${t.data.task.id}/status`, { status: "in_progress" });
      const a = await h.call("user_alice", "POST", `/api/workspaces/${ws}/approvals`, { task_id: t.data.task.id, action: `Approve ${title}` });
      return { task: t.data.task.id, approval: a.data.approval.id };
    };
    const r = await mk("Reject me");
    const rej = await h.call("user_alice", "POST", `/api/workspaces/${ws}/approvals/${r.approval}/decision`, { decision: "rejected" });
    assert.equal(rej.data.task_status, "blocked");
    assert.equal((await h.call("user_alice", "POST", `/api/workspaces/${ws}/approvals/${r.approval}/decision`, { decision: "approved" })).status, 409);
    const c = await mk("Cancel me");
    assert.equal((await h.call("user_alice", "POST", `/api/workspaces/${ws}/approvals/${c.approval}/cancel`)).status, 200);
    const e = await mk("Expire me");
    h.env.DB.raw.prepare("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(e.approval);
    const pending = await h.call("user_alice", "GET", `/api/workspaces/${ws}/approvals`);
    assert.equal(pending.data.approvals.length, 0);
    const all = await h.call("user_alice", "GET", `/api/workspaces/${ws}/approvals?status=all`);
    assert.equal(all.data.approvals.find((a) => a.id === e.approval).status, "expired");
    assert.equal((await h.call("user_alice", "POST", `/api/workspaces/${ws}/approvals/${e.approval}/decision`, { decision: "approved" })).status, 409);
  } finally { h.restore(); }
});

test("per-user rate limit returns 429", async () => {
  const h = await createHarness();
  try {
    h.env.API_RATE_LIMIT_PER_MIN = "5";
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await h.call("user_alice", "GET", "/api/me")).status);
    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.equal(statuses[6], 429);
  } finally { h.restore(); }
});
