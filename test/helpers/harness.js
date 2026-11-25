// Integration harness: real Worker + real migrations + genuinely signed RS256 tokens.
import worker from "../../worker/index.js";
import { D1Shim } from "./d1.js";

const encoder = new TextEncoder();
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const encodeJson = (value) => b64url(encoder.encode(JSON.stringify(value)));

export const ORIGIN = "https://workspace.example.test";
export const ISSUER = "https://clerk.example.test";

export async function createKey(kid = "test-key") {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  Object.assign(jwk, { kid, use: "sig", alg: "RS256" });
  return { privateKey: pair.privateKey, jwk };
}

export async function signToken(key, claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = encodeJson({ alg: "RS256", kid: key.jwk.kid, typ: "JWT", ...header });
  const p = encodeJson({ iss: ISSUER, sub: "user_alice", sid: "sess_1", iat: now, nbf: now - 1, exp: now + 300, azp: ORIGIN, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, encoder.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

export async function createHarness({ db } = {}) {
  const key = await createKey(`kid-${crypto.randomUUID()}`);
  const jwksUrl = `${ISSUER}/${crypto.randomUUID()}/.well-known/jwks.json`;
  const env = {
    DB: db || new D1Shim(),
    ASSETS: { fetch: async () => new Response("<!doctype html><title>ZUVANE</title>", { headers: { "content-type": "text/html" } }) },
    CLERK_ISSUER: ISSUER,
    CLERK_JWKS_URL: jwksUrl,
    CLERK_PUBLISHABLE_KEY: "pk_test_public",
    CLERK_FRONTEND_API_URL: ISSUER,
    CLERK_AUTHORIZED_PARTIES: ORIGIN
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === jwksUrl) return new Response(JSON.stringify({ keys: [key.jwk] }), { headers: { "content-type": "application/json" } });
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  };
  const tokens = new Map();
  const tokenFor = async (sub) => { if (!tokens.has(sub)) tokens.set(sub, await signToken(key, { sub })); return tokens.get(sub); };
  async function call(user, method, path, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (user) headers.authorization = `Bearer ${await tokenFor(user)}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  }
  async function personalWorkspace(user) {
    const me = await call(user, "GET", "/api/me");
    return me.data.workspaces.find((w) => w.kind === "personal").id;
  }
  return { env, key, call, personalWorkspace, restore: () => { globalThis.fetch = originalFetch; } };
}
