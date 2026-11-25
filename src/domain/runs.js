// Agent run state machine. Terminal states never transition again.

export const RUN_STATUSES = Object.freeze(["queued", "assigned", "running", "waiting_approval", "completed", "failed", "cancelled"]);
export const ACTIVE_RUN_STATUSES = Object.freeze(["queued", "assigned", "running", "waiting_approval"]);
export const TERMINAL_RUN_STATUSES = Object.freeze(["completed", "failed", "cancelled"]);

const RUN_TRANSITIONS = Object.freeze({
  queued: ["assigned", "failed", "cancelled"],
  assigned: ["running", "failed", "cancelled"],
  running: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
});

export function canTransitionRun(from, to) {
  return Boolean(RUN_TRANSITIONS[from]?.includes(to));
}

export function assertRunTransition(from, to) {
  if (!canTransitionRun(from, to)) throw new Error(`Run transition from ${from} to ${to} is not allowed.`);
}

export const RISK_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);
export const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;
