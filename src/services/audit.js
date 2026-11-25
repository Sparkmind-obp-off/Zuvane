// Append-only audit trail + structured logs. Never record tokens or secrets.
import { newId, nowIso } from "../http.js";

const SENSITIVE_KEY = /(token|secret|password|authorization|api[_-]?key|cookie|signature)/i;

export function redact(value, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(item, depth + 1);
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export function auditStatement(db, { workspaceId = null, actorType = "user", actorId = null, action, targetType = null, targetId = null, metadata = {}, correlationId = null }) {
  return db.prepare(
    "INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata_json, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(newId("evt"), workspaceId, actorType, actorId, action, targetType, targetId, JSON.stringify(redact(metadata)), correlationId, nowIso());
}

export async function audit(db, event) {
  await auditStatement(db, event).run();
}

export function log(level, message, fields = {}) {
  const entry = { level, message, time: nowIso(), ...redact(fields) };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line); else if (level === "warn") console.warn(line); else console.log(line);
}
