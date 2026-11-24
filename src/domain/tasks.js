export const TASK_STATUSES = Object.freeze([
  "planned",
  "in_progress",
  "needs_approval",
  "completed",
  "blocked"
]);

const transitions = Object.freeze({
  planned: ["in_progress", "blocked"],
  in_progress: ["needs_approval", "completed", "blocked"],
  needs_approval: ["in_progress", "blocked"],
  blocked: ["planned", "in_progress"],
  completed: []
});

export function validateTaskInput(input) {
  if (!input || typeof input !== "object") return { ok: false, error: "Task data is required." };
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length < 3 || title.length > 120) {
    return { ok: false, error: "Title must be between 3 and 120 characters." };
  }
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > 2000) return { ok: false, error: "Description must be 2,000 characters or fewer." };
  const priority = ["low", "normal", "high"].includes(input.priority) ? input.priority : "normal";
  return { ok: true, value: { title, description, priority } };
}

export function canTransitionTask(from, to) {
  return Boolean(transitions[from]?.includes(to));
}

export function transitionTask(task, nextStatus) {
  if (!task || !TASK_STATUSES.includes(task.status)) {
    return { ok: false, error: "Task or current status is invalid." };
  }
  if (!TASK_STATUSES.includes(nextStatus) || !canTransitionTask(task.status, nextStatus)) {
    return { ok: false, error: `Transition from ${task.status} to ${nextStatus} is not allowed.` };
  }
  return { ok: true, value: { ...task, status: nextStatus } };
}

export function approvalDecision(approval, decision) {
  if (!approval || approval.status !== "pending") {
    return { ok: false, error: "Only pending approvals can be decided." };
  }
  if (decision !== "approved" && decision !== "rejected") {
    return { ok: false, error: "Decision must be approved or rejected." };
  }
  return { ok: true, value: { ...approval, status: decision } };
}
