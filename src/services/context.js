// Identity provisioning and workspace membership resolution.
// The user ID always comes from the verified Clerk token subject — never from the client.
import { nowIso, newId, forbidden, notFound } from "../http.js";
import { auditStatement, log } from "./audit.js";
import { can, permissionsFor } from "../domain/rbac.js";

const PROFILE_SYNC_MS = 24 * 60 * 60 * 1000;

async function fetchClerkProfile(env, userId, fetcher = fetch) {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const response = await fetcher(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}`, accept: "application/json" }
    });
    if (!response.ok) return null;
    const user = await response.json();
    const primary = (user.email_addresses || []).find((email) => email.id === user.primary_email_address_id) || (user.email_addresses || [])[0];
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
    return { email: primary?.email_address?.toLowerCase() || null, displayName: name || user.username || null };
  } catch {
    return null;
  }
}

/** Ensures the user row, personal workspace and owner membership exist. Idempotent. */
export async function provisionUser(env, userId, { fetcher = fetch, correlationId } = {}) {
  const db = env.DB;
  const timestamp = nowIso();
  let user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  if (!user) {
    await db.prepare("INSERT INTO users (id, created_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING")
      .bind(userId, timestamp, timestamp).run();
    user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
  } else if (Date.parse(user.last_seen_at) < Date.now() - 5 * 60 * 1000) {
    await db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(timestamp, userId).run();
  }

  if (!user.profile_synced_at || Date.parse(user.profile_synced_at) < Date.now() - PROFILE_SYNC_MS) {
    const profile = await fetchClerkProfile(env, userId, fetcher);
    if (profile) {
      await db.prepare("UPDATE users SET email = ?, display_name = ?, profile_synced_at = ? WHERE id = ?")
        .bind(profile.email, profile.displayName, timestamp, userId).run();
      user = { ...user, email: profile.email, display_name: profile.displayName, profile_synced_at: timestamp };
    }
  }

  let personal = await db.prepare("SELECT * FROM workspaces WHERE created_by = ? AND kind = 'personal'").bind(userId).first();
  if (!personal) {
    const workspaceId = newId("ws");
    await db.batch([
      db.prepare("INSERT INTO workspaces (id, name, kind, created_by, created_at, updated_at) VALUES (?, 'Personal space', 'personal', ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(workspaceId, userId, timestamp, timestamp),
      db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, added_by, created_at) SELECT id, ?, 'owner', ?, ? FROM workspaces WHERE created_by = ? AND kind = 'personal' ON CONFLICT DO NOTHING")
        .bind(userId, userId, timestamp, userId),
      // Adopt legacy (pre-0003) user-owned tasks and approvals into the personal workspace.
      db.prepare("UPDATE tasks SET workspace_id = (SELECT id FROM workspaces WHERE created_by = ? AND kind = 'personal') WHERE owner_id = ? AND workspace_id IS NULL")
        .bind(userId, userId),
      db.prepare("UPDATE approvals SET workspace_id = (SELECT workspace_id FROM tasks WHERE tasks.id = approvals.task_id) WHERE workspace_id IS NULL AND task_id IN (SELECT id FROM tasks WHERE owner_id = ?)")
        .bind(userId)
    ]);
    personal = await db.prepare("SELECT * FROM workspaces WHERE created_by = ? AND kind = 'personal'").bind(userId).first();
    await auditStatement(db, { workspaceId: personal.id, actorId: userId, action: "workspace.provisioned", targetType: "workspace", targetId: personal.id, correlationId }).run();
    log("info", "personal workspace provisioned", { correlationId, workspaceId: personal.id });
  }
  return user;
}

export async function listMemberships(db, userId) {
  const { results = [] } = await db.prepare(
    "SELECT w.id, w.name, w.kind, w.created_at, m.role FROM workspace_members m INNER JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY CASE w.kind WHEN 'personal' THEN 0 ELSE 1 END, w.created_at ASC"
  ).bind(userId).all();
  return results.map((row) => ({ ...row, permissions: permissionsFor(row.role) }));
}

/** Resolves membership; non-members get 404 (no existence disclosure). */
export async function resolveWorkspace(db, userId, workspaceId) {
  if (typeof workspaceId !== "string" || !/^[A-Za-z0-9_-]{3,80}$/.test(workspaceId)) throw notFound("Workspace not found.");
  const row = await db.prepare(
    "SELECT w.id, w.name, w.kind, w.created_by, m.role FROM workspace_members m INNER JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.user_id = ?"
  ).bind(workspaceId, userId).first();
  if (!row) throw notFound("Workspace not found.");
  return row;
}

export function requirePermission(role, permission) {
  if (!can(role, permission)) throw forbidden();
}
