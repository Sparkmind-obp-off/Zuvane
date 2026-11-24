import test from "node:test";
import assert from "node:assert/strict";
import {
  validateTaskInput,
  canTransitionTask,
  transitionTask,
  approvalDecision
} from "../src/domain/tasks.js";

test("validates and normalizes task input", () => {
  assert.deepEqual(validateTaskInput({ title: "  Prepare launch  ", description: "  checklist ", priority: "high" }), {
    ok: true,
    value: { title: "Prepare launch", description: "checklist", priority: "high" }
  });
});

test("rejects too-short task titles", () => {
  assert.equal(validateTaskInput({ title: "ok" }).ok, false);
});

test("rejects descriptions above the size limit", () => {
  assert.equal(validateTaskInput({ title: "Valid title", description: "x".repeat(2001) }).ok, false);
});

test("allows only explicit task state transitions", () => {
  assert.equal(canTransitionTask("planned", "in_progress"), true);
  assert.equal(canTransitionTask("completed", "in_progress"), false);
  assert.equal(canTransitionTask("planned", "completed"), false);
});

test("returns a new task when transition is allowed", () => {
  const task = { id: "t1", title: "Build", status: "planned" };
  assert.deepEqual(transitionTask(task, "in_progress"), {
    ok: true,
    value: { ...task, status: "in_progress" }
  });
  assert.equal(task.status, "planned");
});

test("approval decisions require a pending approval and valid decision", () => {
  const approval = { id: "a1", status: "pending" };
  assert.equal(approvalDecision(approval, "approved").value.status, "approved");
  assert.equal(approvalDecision(approval, "maybe").ok, false);
  assert.equal(approvalDecision({ ...approval, status: "approved" }, "rejected").ok, false);
});
