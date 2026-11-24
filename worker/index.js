import { validateTaskInput, transitionTask, approvalDecision } from "../src/domain/tasks.js";

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
      return json({ ok: true, service: "zuvane-workspace-api", version: "0.1.0" });
    }

    if (!env.DB) return json({ error: "Database binding is not configured." }, 503);

    if (request.method === "GET" && url.pathname === "/api/tasks") {
      const { results = [] } = await env.DB.prepare(
        "SELECT id, title, description, status, priority, created_at, updated_at FROM tasks ORDER BY updated_at DESC LIMIT 100"
      ).all();
      return json({ tasks: results });
    }

    if (request.method === "POST" && url.pathname === "/api/tasks") {
      const parsed = validateTaskInput(await readBody(request));
      if (!parsed.ok) return json({ error: parsed.error }, 400);
      const timestamp = now();
      const task = { id: id(), ...parsed.value, status: "planned", created_at: timestamp, updated_at: timestamp };
      await env.DB.prepare(
        "INSERT INTO tasks (id, title, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(task.id, task.title, task.description, task.status, task.priority, task.created_at, task.updated_at).run();
      return json({ task }, 201);
    }

    const statusMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (request.method === "PATCH" && statusMatch) {
      const body = await readBody(request);
      const current = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(statusMatch[1]).first();
      if (!current) return json({ error: "Task not found." }, 404);
      const moved = transitionTask(current, body?.status);
      if (!moved.ok) return json({ error: moved.error }, 409);
      const updatedAt = now();
      await env.DB.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .bind(moved.value.status, updatedAt, current.id).run();
      return json({ task: { ...moved.value, updated_at: updatedAt } });
    }

    if (request.method === "POST" && url.pathname === "/api/approvals") {
      const body = await readBody(request);
      if (!body?.task_id || typeof body.action !== "string" || body.action.length > 160) {
        return json({ error: "task_id and a short action description are required." }, 400);
      }
      const task = await env.DB.prepare("SELECT id, status FROM tasks WHERE id = ?").bind(body.task_id).first();
      if (!task) return json({ error: "Task not found." }, 404);
      if (task.status !== "in_progress") return json({ error: "Only in-progress tasks can request approval." }, 409);
      const approval = { id: id(), task_id: task.id, action: body.action, status: "pending", requested_at: now() };
      await env.DB.batch([
        env.DB.prepare("INSERT INTO approvals (id, task_id, action, status, requested_at) VALUES (?, ?, ?, ?, ?)")
          .bind(approval.id, approval.task_id, approval.action, approval.status, approval.requested_at),
        env.DB.prepare("UPDATE tasks SET status = 'needs_approval', updated_at = ? WHERE id = ?")
          .bind(approval.requested_at, task.id)
      ]);
      return json({ approval }, 201);
    }

    if (request.method === "GET" && url.pathname === "/api/approvals") {
      const { results = [] } = await env.DB.prepare(
        "SELECT id, task_id, action, status, requested_at, decided_at FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC"
      ).all();
      return json({ approvals: results });
    }

    const decisionMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (request.method === "POST" && decisionMatch) {
      const body = await readBody(request);
      const approval = await env.DB.prepare("SELECT * FROM approvals WHERE id = ?").bind(decisionMatch[1]).first();
      if (!approval) return json({ error: "Approval not found." }, 404);
      const decided = approvalDecision(approval, body?.decision);
      if (!decided.ok) return json({ error: decided.error }, 409);
      const decidedAt = now();
      const nextTaskStatus = body.decision === "approved" ? "in_progress" : "blocked";
      await env.DB.batch([
        env.DB.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
          .bind(body.decision, decidedAt, approval.id),
        env.DB.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'needs_approval'")
          .bind(nextTaskStatus, decidedAt, approval.task_id)
      ]);
      return json({ approval: { ...decided.value, decided_at: decidedAt }, task_status: nextTaskStatus });
    }

    return json({ error: "Not found." }, 404);
  }
};
