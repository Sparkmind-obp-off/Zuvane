const decodeBase64Url = (value) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const decodeJsonPart = (value) => JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));

const jwksCache = new Map();
const JWKS_TTL_MS = 5 * 60 * 1000;

async function loadJwks(jwksUrl, fetcher = fetch, now = Date.now()) {
  const cached = jwksCache.get(jwksUrl);
  if (cached && cached.expiresAt > now) return cached.keys;

  let response;
  try {
    response = await fetcher(jwksUrl, { headers: { accept: "application/json" } });
  } catch {
    throw new Error("Clerk JWKS service is unavailable.");
  }
  if (!response.ok) throw new Error(`Clerk JWKS request failed (${response.status}).`);
  const body = await response.json();
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error("Clerk JWKS did not contain signing keys.");
  jwksCache.set(jwksUrl, { keys: body.keys, expiresAt: now + JWKS_TTL_MS });
  return body.keys;
}

export async function verifyClerkToken(token, {
  issuer,
  jwksUrl,
  authorizedParties = [],
  requestOrigin,
  fetcher = fetch,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  if (typeof token !== "string" || token.length > 16_384) throw new Error("Missing or invalid session token.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed session token.");

  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported session token signing algorithm.");
  if (claims.iss !== issuer) throw new Error("Session token issuer does not match this Clerk instance.");
  if (typeof claims.sub !== "string" || !claims.sub.startsWith("user_")) throw new Error("Session token subject is invalid.");
  if (!Number.isFinite(claims.exp) || claims.exp <= now) throw new Error("Session token has expired.");
  if (Number.isFinite(claims.nbf) && claims.nbf > now + 5) throw new Error("Session token is not active yet.");

  if (claims.azp) {
    const permitted = authorizedParties.length ? authorizedParties : [requestOrigin].filter(Boolean);
    if (!permitted.includes(claims.azp)) throw new Error("Session token authorized party is not permitted.");
  }

  const keys = await loadJwks(jwksUrl, fetcher, now * 1000);
  const jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA" && candidate.use !== "enc");
  if (!jwk) throw new Error("No matching Clerk signing key was found.");

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = decodeBase64Url(parts[2]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, signingInput);
  if (!valid) throw new Error("Session token signature is invalid.");
  return claims;
}

export async function authenticateClerkRequest(request, env) {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return { ok: false, status: 401, error: "Sign in to access this workspace." };

  const issuer = env.CLERK_ISSUER;
  const jwksUrl = env.CLERK_JWKS_URL;
  if (!issuer || !jwksUrl) return { ok: false, status: 503, error: "Clerk authentication is not configured on this Worker." };

  const authorizedParties = String(env.CLERK_AUTHORIZED_PARTIES || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  try {
    const claims = await verifyClerkToken(match[1], {
      issuer,
      jwksUrl,
      authorizedParties,
      requestOrigin: new URL(request.url).origin,
    });
    return { ok: true, userId: claims.sub, sessionId: claims.sid || null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Session verification failed.";
    if (message.startsWith("Clerk JWKS request failed") || message.includes("JWKS")) {
      return { ok: false, status: 503, error: "Clerk verification is temporarily unavailable." };
    }
    return { ok: false, status: 401, error: "Your session is invalid or expired. Sign in again." };
  }
}
