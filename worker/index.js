// ZUVANE Worker entry: static assets + authenticated, workspace-scoped JSON API.
import { authenticateClerkRequest } from "../src/auth/clerk.js";
import { HttpError, errorResponse, json, withSecurityHeaders } from "../src/http.js";
import { provisionUser, resolveWorkspace } from "../src/services/context.js";
import { enforceRateLimit } from "../src/services/ratelimit.js";
import { audit, log } from "../src/services/audit.js";
import * as api from "../src/api/routes.js";

export const VERSION = "0.3.0";

// [method, pattern, handler, scope] — scope "user" = authenticated only; "workspace" = membership required.
const ROUTES = [
  ["GET", /^\/api\/me$/, api.getMe, "user"],
  ["GET", /^\/api\/catalog$/, api.getCatalog, "user"],
  ["POST", /^\/api\/workspaces$/, api.createWorkspace, "user"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)$/, api.getWorkspace, "workspace"],
  ["PATCH", /^\/api\/workspaces\/(?<ws>[^/]+)$/, api.updateWorkspace, "workspace"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)\/overview$/, api.getOverview, "workspace"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)\/members$/, api.listMembers, "workspace"],
  ["POST", /^\/api\/workspaces\/(?<ws>[^/]+)\/members$/, api.addMember, "workspace"],
  ["PATCH", /^\/api\/workspaces\/(?<ws>[^/]+)\/members\/(?<memberId>[^/]+)$/, api.updateMember, "workspace"],
  ["DELETE", /^\/api\/workspaces\/(?<ws>[^/]+)\/members\/(?<memberId>[^/]+)$/, api.removeMember, "workspace"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)\/tasks$/, api.listTasks, "workspace"],
  ["POST", /^\/api\/workspaces\/(?<ws>[^/]+)\/tasks$/, api.createTask, "workspace"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)\/tasks\/(?<taskId>[^/]+)$/, api.getTask, "workspace"],
  ["PATCH", /^\/api\/workspaces\/(?<ws>[^/]+)\/tasks\/(?<taskId>[^/]+)$/, api.updateTask, "workspace"],
  ["PATCH", /^\/api\/workspaces\/(?<ws>[^/]+)\/tasks\/(?<taskId>[^/]+)\/status$/, api.setTaskStatus, "workspace"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)\/approvals$/, api.listApprovals, "workspace"],
  ["POST", /^\/api\/workspaces\/(?<ws>[^/]+)\/approvals$/, api.requestApproval, "workspace"],
  ["POST", /^\/api\/workspaces\/(?<ws>[^/]+)\/approvals\/(?<approvalId>[^/]+)\/decision$/, api.decideApproval, "workspace"],
  ["POST", /^\/api\/workspaces\/(?<ws>[^/]+)\/approvals\/(?<approvalId>[^/]+)\/cancel$/, api.cancelApproval, "workspace"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)\/agents$/, api.listAgents, "workspace"],
  ["POST", /^\/api\/workspaces\/(?<ws>[^/]+)\/agents$/, api.createAgent, "workspace"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)\/agents\/(?<agentId>[^/]+)$/, api.getAgent, "workspace"],
  ["PATCH", /^\/api\/workspaces\/(?<ws>[^/]+)\/agents\/(?<agentId>[^/]+)$/, api.updateAgent, "workspace"],
  ["POST", /^\/api\/workspaces\/(?<ws>[^/]+)\/agents\/(?<agentId>[^/]+)\/status$/, api.setAgentStatus, "workspace"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)\/runs$/, api.listRuns, "workspace"],
  ["POST", /^\/api\/workspaces\/(?<ws>[^/]+)\/runs$/, api.createRun, "workspace"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)\/runs\/(?<runId>[^/]+)$/, api.getRun, "workspace"],
  ["POST", /^\/api\/workspaces\/(?<ws>[^/]+)\/runs\/(?<runId>[^/]+)\/cancel$/, api.cancelRunHandler, "workspace"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)\/integrations$/, api.listIntegrations, "workspace"],
  ["POST", /^\/api\/workspaces\/(?<ws>[^/]+)\/integrations$/, api.createIntegration, "workspace"],
  ["PATCH", /^\/api\/workspaces\/(?<ws>[^/]+)\/integrations\/(?<connectionId>[^/]+)$/, api.updateIntegration, "workspace"],
  ["GET", /^\/api\/workspaces\/(?<ws>[^/]+)\/activity$/, api.listActivity, "workspace"]
];

function allowedOrigins(env, url) {
  const configured = String(env.CLERK_AUTHORIZED_PARTIES || "").split(",").map((v) => v.trim()).filter(Boolean);
  return configured.length ? configured : [url.origin];
}

async function handleApi(request, env, ctxExec, correlationId) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true, service: "zuvane-workspace-api", version: VERSION, database: Boolean(env.DB), auth_configured: Boolean(env.CLERK_ISSUER && env.CLERK_JWKS_URL) });
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    if (!env.CLERK_PUBLISHABLE_KEY || !env.CLERK_FRONTEND_API_URL) return errorResponse(503, "not_configured", "Clerk frontend configuration is missing.", correlationId);
    return json({ publishableKey: env.CLERK_PUBLISHABLE_KEY, frontendApiUrl: env.CLERK_FRONTEND_API_URL });
  }

  // CSRF defence-in-depth: state-changing requests must come from an allowed origin when an Origin header is present.
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && !allowedOrigins(env, url).includes(origin)) return errorResponse(403, "origin_not_allowed", "Request origin is not allowed.", correlationId);
  }

  const auth = await authenticateClerkRequest(request, env);
  if (!auth.ok) {
    if (auth.status === 401 && env.DB && request.headers.get("authorization")) {
      // Record failed verification attempts without any token material.
      ctxExec?.waitUntil?.(audit(env.DB, { actorType: "system", actorId: "auth", action: "auth.rejected", metadata: { path: url.pathname, reason: auth.error }, correlationId }).catch(() => {}));
    }
    return errorResponse(auth.status, auth.status === 401 ? "unauthenticated" : "auth_unavailable", auth.error, correlationId);
  }
  if (!env.DB) return errorResponse(503, "not_configured", "Database binding is not configured.", correlationId);

  const route = ROUTES.find(([method, pattern]) => method === request.method && pattern.test(url.pathname));
  if (!route) {
    const pathExists = ROUTES.some(([, pattern]) => pattern.test(url.pathname));
    return errorResponse(pathExists ? 405 : 404, pathExists ? "method_not_allowed" : "not_found", pathExists ? "Method not allowed." : "Not found.", correlationId);
  }
  const [, pattern, handler, scope] = route;
  const params = { ...(url.pathname.match(pattern).groups || {}) };

  await enforceRateLimit(env.DB, `api:${auth.userId}`, { limit: Number(env.API_RATE_LIMIT_PER_MIN || 300) });
  await provisionUser(env, auth.userId, { correlationId });
  const ctx = { request, env, url, userId: auth.userId, sessionId: auth.sessionId, correlationId };
  if (scope === "workspace") ctx.workspace = await resolveWorkspace(env.DB, auth.userId, params.ws);
  return handler(ctx, params);
}

export default {
  async fetch(request, env, ctxExec) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      const response = await env.ASSETS.fetch(request);
      return withSecurityHeaders(response, env);
    }
    const correlationId = request.headers.get("cf-ray") || crypto.randomUUID();
    const started = Date.now();
    let response;
    try {
      response = await handleApi(request, env, ctxExec, correlationId);
    } catch (error) {
      if (error instanceof HttpError) {
        response = errorResponse(error.status, error.code, error.message, correlationId, error.details);
      } else {
        log("error", "unhandled api error", { correlationId, path: url.pathname, error: error instanceof Error ? error.message : String(error) });
        response = errorResponse(500, "internal_error", "An unexpected error occurred.", correlationId);
      }
    }
    log(response.status >= 500 ? "error" : "info", "api request", { correlationId, method: request.method, path: url.pathname, status: response.status, ms: Date.now() - started });
    const out = withSecurityHeaders(response, env);
    out.headers.set("x-correlation-id", correlationId);
    return out;
  }
};
