// HTTP helpers: consistent JSON envelopes, typed errors, safe body parsing.

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, "invalid_request", message, details);
export const forbidden = (message = "You do not have permission to perform this action.") => new HttpError(403, "forbidden", message);
export const notFound = (message = "Resource not found.") => new HttpError(404, "not_found", message);
export const conflict = (message, details) => new HttpError(409, "conflict", message, details);

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

export function errorResponse(status, code, message, correlationId, details) {
  const body = { error: message, code };
  if (details !== undefined) body.details = details;
  if (correlationId) body.correlation_id = correlationId;
  return json(body, status);
}

const MAX_BODY_BYTES = 64 * 1024;

export async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body is too large.");
  let text;
  try { text = await request.text(); } catch { throw badRequest("Request body could not be read."); }
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body is too large.");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw badRequest("Request body must be a JSON object.");
  }
}

export const nowIso = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;

export function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function cleanString(value, { field, min = 0, max, required = false }) {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`${field} is required.`);
    return "";
  }
  if (typeof value !== "string") throw badRequest(`${field} must be a string.`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw badRequest(`${field} is required.`);
  if (trimmed.length < min || trimmed.length > max) {
    throw badRequest(`${field} must be between ${min} and ${max} characters.`);
  }
  return trimmed;
}

export const SECURITY_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin-allow-popups"
});

export function contentSecurityPolicy(frontendApiUrl) {
  let clerk = "";
  try { clerk = frontendApiUrl ? new URL(frontendApiUrl).origin : ""; } catch { clerk = ""; }
  return [
    "default-src 'self'",
    `script-src 'self' ${clerk} https://cdn.protect.clerk.com https://challenges.cloudflare.com https://accounts.google.com https://static.cloudflareinsights.com`.trim(),
    `connect-src 'self' ${clerk} https://cdn.protect.clerk.com https://*.protect.clerk.com https://*.client.protect.clerk.com:* https://accounts.google.com https://clerk-telemetry.com https://cloudflareinsights.com`.trim(),
    "img-src 'self' data: https://img.clerk.com https://*.googleusercontent.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-src 'self' https://challenges.cloudflare.com https://accounts.google.com https://cdn.protect.clerk.com",
    "worker-src 'self' blob:",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}

export function withSecurityHeaders(response, env = {}) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  const type = headers.get("content-type") || "";
  if (type.includes("text/html")) headers.set("content-security-policy", contentSecurityPolicy(env.CLERK_FRONTEND_API_URL));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
