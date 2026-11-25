import test from "node:test";
import assert from "node:assert/strict";
import { verifyClerkToken, authenticateClerkRequest } from "../src/auth/clerk.js";

const encoder = new TextEncoder();
const toBase64Url = (bytes) => Buffer.from(bytes).toString("base64url");
const encodeJson = (value) => toBase64Url(encoder.encode(JSON.stringify(value)));

async function fixture(overrides = {}) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk.kid = "test-key";
  jwk.use = "sig";
  const claims = {
    iss: "https://clerk.example.test",
    sub: "user_test123",
    sid: "sess_test123",
    exp: 2_000_000_000,
    nbf: 1_700_000_000,
    azp: "https://workspace.example.test",
    ...overrides
  };
  const header = encodeJson({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const payload = encodeJson(claims);
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, encoder.encode(input));
  return {
    token: `${input}.${toBase64Url(signature)}`,
    jwks: { keys: [jwk] },
    fetcher: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "content-type": "application/json" } })
  };
}

const baseOptions = (f) => ({
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
  authorizedParties: ["https://workspace.example.test"],
  now: 1_800_000_000,
  fetcher: f.fetcher
});

test("verifies a Clerk RS256 session and returns its user claims", async () => {
  const f = await fixture();
  const claims = await verifyClerkToken(f.token, baseOptions(f));
  assert.equal(claims.sub, "user_test123");
  assert.equal(claims.sid, "sess_test123");
});

test("rejects expired sessions", async () => {
  const f = await fixture({ exp: 1_700_000_000 });
  await assert.rejects(verifyClerkToken(f.token, baseOptions(f)), /expired/);
});

test("rejects a mismatched issuer", async () => {
  const f = await fixture();
  await assert.rejects(verifyClerkToken(f.token, { ...baseOptions(f), issuer: "https://other.example.test" }), /issuer/);
});

test("rejects an unapproved authorized party", async () => {
  const f = await fixture({ azp: "https://attacker.example.test" });
  await assert.rejects(verifyClerkToken(f.token, baseOptions(f)), /authorized party/);
});

test("rejects a tampered signature", async () => {
  const f = await fixture();
  const parts = f.token.split(".");
  parts[2] = toBase64Url(crypto.getRandomValues(new Uint8Array(256)));
  await assert.rejects(verifyClerkToken(parts.join("."), baseOptions(f)), /signature/);
});

test("returns 401 when a request has no bearer session", async () => {
  const result = await authenticateClerkRequest(new Request("https://workspace.example.test/api/tasks"), {});
  assert.deepEqual(result, { ok: false, status: 401, error: "Sign in to access this workspace." });
});
