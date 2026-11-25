// Workspace role-based access control. Deterministic and server-enforced.

export const ROLES = Object.freeze(["owner", "admin", "member", "viewer"]);
const RANK = Object.freeze({ viewer: 1, member: 2, admin: 3, owner: 4 });

// Minimum role required for each permission.
export const PERMISSIONS = Object.freeze({
  "workspace.read": "viewer",
  "activity.read": "viewer",
  "workspace.update": "admin",
  "member.manage": "admin",
  "task.write": "member",
  "approval.request": "member",
  "approval.decide": "admin",
  "agent.manage": "admin",
  "run.create": "member",
  "run.cancel": "member",
  "integration.manage": "admin"
});

export function roleRank(role) {
  return RANK[role] || 0;
}

export function can(role, permission) {
  const required = PERMISSIONS[permission];
  if (!required) return false; // unknown permissions are denied
  return roleRank(role) >= roleRank(required);
}

export function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((permission) => can(role, permission));
}

// Who may assign / change / remove a membership with a given role.
export function canManageRole(actorRole, targetCurrentRole, targetNextRole) {
  if (!can(actorRole, "member.manage")) return false;
  if (actorRole === "owner") return true;
  // Admins manage members and viewers only, and cannot promote to admin/owner.
  const touchesPrivileged = [targetCurrentRole, targetNextRole].some((role) => role === "admin" || role === "owner");
  return !touchesPrivileged;
}
