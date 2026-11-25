import { validateTaskInput, transitionTask, approvalDecision } from "../src/domain/tasks.js";
import { authenticateClerkRequest } from "../src/auth/clerk.js";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, service: "zuvane-workspace-api", version: "0.2.0" });
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      if (!env.CLERK_PUBLISHABLE_KEY || !env.CLERK_FRONTEND_API_URL) {
        return json({ error: "Clerk frontend configuration is missing." }, 503);
      }
      return json({ publishableKey: env.CLERK_PUBLISHABLE_KEY, frontendApiUrl: env.CLERK_FRONTEND_API_URL });
    }

    const auth = await authenticateClerkRequest(request, env);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    const ownerId = auth.userId;

    if (!env.DB) return json({ error: "Database binding is not configured." }, 503);

    if (request.method === "GET" && url.pathname === "/api/tasks") {
      const { results = [] } = await env.DB.prepare(
        "SELECT id, title, description, status, priority, created_at, updated_at FROM tasks WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 100"
      ).bind(ownerId).all();
      return json({ tasks: results });
    }

    if (request.method === "POST" && url.pathname === "/api/tasks") {
      const parsed = validateTaskInput(await readBody(request));
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const timestamp = now();
      const task = { id: id(), ...parsed.value, status: "planned", created_at: timestamp, updated_at: timestamp };
      await env.DB.prepare(
        "INSERT INTO tasks (id, owner_id, title, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(task.id, ownerId, task.title, task.description, task.status, task.priority, task.created_at, task.updated_at).run();
      return json({ task }, 201);
    }

    const statusMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (request.method === "PATCH" && statusMatch) {
      const body = await readBody(request);
      const current = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND owner_id = ?")
        .bind(statusMatch[1], ownerId).first();
      if (!current) return json({ error: "Task not found." }, 404);
      const moved = transitionTask(current, body?.status);
      if (!moved.ok) return json({ error: moved.error }, 409);
      const updatedAt = now();
      await env.DB.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
        .bind(moved.value.status, updatedAt, current.id, ownerId).run();
      return json({ task: { ...moved.value, updated_at: updatedAt } });
    }

    if (request.method === "POST" && url.pathname === "/api/approvals") {
      const body = await readBody(request);
      const action = typeof body?.action === "string" ? body.action.trim() : "";
      if (!body?.task_id || !action || action.length > 160) {
        return json({ error: "task_id and a short action description are required." }, 400);
      }
      const task = await env.DB.prepare("SELECT id, status FROM tasks WHERE id = ? AND owner_id = ?")
        .bind(body.task_id, ownerId).first();
      if (!task) return json({ error: "Task not found." }, 404);
      if (task.status !== "in_progress") return json({ error: "Only in-progress tasks can request approval." }, 409);
      const approval = { id: id(), task_id: task.id, action, status: "pending", requested_at: now() };
      await env.DB.batch([
        env.DB.prepare("INSERT INTO approvals (id, task_id, action, status, requested_at) VALUES (?, ?, ?, ?, ?)")
          .bind(approval.id, approval.task_id, approval.action, approval.status, approval.requested_at),
        env.DB.prepare("UPDATE tasks SET status = 'needs_approval', updated_at = ? WHERE id = ? AND owner_id = ?")
          .bind(approval.requested_at, task.id, ownerId)
      ]);
      return json({ approval }, 201);
    }

    if (request.method === "GET" && url.pathname === "/api/approvals") {
      const { results = [] } = await env.DB.prepare(
        "SELECT a.id, a.task_id, a.action, a.status, a.requested_at, a.decided_at FROM approvals a INNER JOIN tasks t ON t.id = a.task_id WHERE a.status = 'pending' AND t.owner_id = ? ORDER BY a.requested_at ASC"
      ).bind(ownerId).all();
      return json({ approvals: results });
    }

    const decisionMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (request.method === "POST" && decisionMatch) {
      const body = await readBody(request);
      const approval = await env.DB.prepare(
        "SELECT a.* FROM approvals a INNER JOIN tasks t ON t.id = a.task_id WHERE a.id = ? AND t.owner_id = ?"
      ).bind(decisionMatch[1], ownerId).first();
      if (!approval) return json({ error: "Approval not found." }, 404);
      const decided = approvalDecision(approval, body?.decision);
      if (!decided.ok) return json({ error: decided.error }, 409);
      const decidedAt = now();
      const nextTaskStatus = body.decision === "approved" ? "in_progress" : "blocked";
      await env.DB.batch([
        env.DB.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
          .bind(body.decision, decidedAt, approval.id),
        env.DB.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'needs_approval'")
          .bind(nextTaskStatus, decidedAt, approval.task_id, ownerId)
      ]);
      return json({ approval: { ...decided.value, decided_at: decidedAt }, task_status: nextTaskStatus });
    }

    return json({ error: "Not found." }, 404);
  }
};