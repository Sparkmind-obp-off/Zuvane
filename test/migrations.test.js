import test from "node:test";
import assert from "node:assert/strict";
import { D1Shim } from "./helpers/d1.js";
import { createHarness } from "./helpers/harness.js";

test("all migrations apply cleanly and create the expected schema", () => {
  const db = new D1Shim();
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  for (const t of ["users", "workspaces", "workspace_members", "tasks", "agents", "agent_runs", "run_steps", "approvals", "tool_connections", "audit_events", "usage_records", "rate_limits"]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  assert.ok(!tables.includes("approvals_v2"));
  const fk = db.raw.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(fk, []);
});

test("schema constraints reject invalid data", () => {
  const db = new D1Shim();
  db.raw.exec("INSERT INTO users (id, created_at, last_seen_at) VALUES ('user_x', 'n', 'n')");
  db.raw.exec("INSERT INTO workspaces (id, name, kind, created_by, created_at, updated_at) VALUES ('ws_x', 'W', 'personal', 'user_x', 'n', 'n')");
  assert.throws(() => db.raw.exec("INSERT INTO workspaces (id, name, kind, created_by, created_at, updated_at) VALUES ('ws_y', 'W2', 'personal', 'user_x', 'n', 'n')"), /UNIQUE/);
  assert.throws(() => db.raw.exec("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_x', 'user_x', 'superuser', 'n')"), /CHECK/);
  assert.throws(() => db.raw.exec("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws_missing', 'user_x', 'owner', 'n')"), /FOREIGN KEY/);
  assert.throws(() => db.raw.exec("INSERT INTO agents (id, workspace_id, name, agent_type, provider, model, max_steps, created_by, created_at, updated_at) VALUES ('a', 'ws_x', 'A', 'assistant', 'mock', 'm', 999, 'user_x', 'n', 'n')"), /CHECK/);
});

test("legacy 0001/0002 data is preserved and adopted into the owner's personal workspace", async () => {
  const db = new D1Shim({ upTo: 2 });
  db.raw.exec(`
    INSERT INTO tasks (id, title, description, status, priority, created_at, updated_at, owner_id) VALUES ('legacy-1', 'Legacy task', '', 'needs_approval', 'normal', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'user_legacy');
    INSERT INTO tasks (id, title, description, status, priority, created_at, updated_at, owner_id) VALUES ('orphan-1', 'Orphan', '', 'planned', 'normal', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO approvals (id, task_id, action, status, requested_at) VALUES ('legacy-apr', 'legacy-1', 'Legacy approval', 'pending', '2026-01-01T00:00:00.000Z');
  `);
  db.migrateRemaining();
  const h = await createHarness({ db });
  try {
    const ws = await h.personalWorkspace("user_legacy");
    const tasks = await h.call("user_legacy", "GET", `/api/workspaces/${ws}/tasks`);
    assert.deepEqual(tasks.data.tasks.map((t) => t.id), ["legacy-1"]);
    const approvals = await h.call("user_legacy", "GET", `/api/workspaces/${ws}/approvals`);
    assert.equal(approvals.data.approvals[0].id, "legacy-apr");
    assert.equal(approvals.data.approvals[0].requested_by, "user_legacy");
    // Orphaned rows stay invisible to everyone.
    const other = await h.personalWorkspace("user_other");
    assert.deepEqual((await h.call("user_other", "GET", `/api/workspaces/${other}/tasks`)).data.tasks, []);
  } finally { h.restore(); }
});
