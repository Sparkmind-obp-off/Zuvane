// Fixed-window rate limiter persisted in D1 (no paid add-on required).
import { HttpError } from "../http.js";

export async function enforceRateLimit(db, key, { limit, windowSeconds = 60, now = Date.now() }) {
  const windowStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
  const row = await db.prepare(
    "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) " +
    "ON CONFLICT(key) DO UPDATE SET count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END, " +
    "window_start = excluded.window_start RETURNING count"
  ).bind(key, windowStart).first();
  const count = Number(row?.count || 0);
  if (count > limit) {
    const retryAfter = windowStart + windowSeconds - Math.floor(now / 1000);
    throw new HttpError(429, "rate_limited", "Too many requests. Please slow down.", { retry_after_seconds: Math.max(1, retryAfter) });
  }
  return count;
}
