import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";
import { createHarness, signToken, createKey, ORIGIN, ISSUER } from "./helpers/harness.js";

test("keeps the health endpoint public", async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/api/health`), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.auth_configured, false);
});

test("exposes only public Clerk frontend configuration", async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/api/config`), {
    CLERK_PUBLISHABLE_KEY: "pk_test_public",
    CLERK_FRONTEND_API_URL: "https://clerk.example.test",
    CLERK_SECRET_KEY: "sk_test_must_not_leak"
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { publishableKey: "pk_test_public", frontendApiUrl: "https://clerk.example.test" });
  assert.ok(!text.includes("sk_test"));
});

test("unauthenticated API request returns 401 before touching the database", async () => {
  let touched = false;
  const db = { prepare() { touched = true; throw new Error("db touched"); } };
  const response = await worker.fetch(new Request(`${ORIGIN}/api/me`), { DB: db, CLERK_ISSUER: ISSUER, CLERK_JWKS_URL: `${ISSUER}/jwks` });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "unauthenticated");
  assert.equal(touched, false);
});

test("missing Clerk verification configuration fails closed with 503", async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/api/me`, { headers: { authorization: "Bearer a.b.c" } }), { DB: {} });
  assert.equal(response.status, 503);
});

test("rejects expired, wrong-issuer, wrong-azp, tampered and foreign-key tokens; accepts a valid one", async () => {
  const h = await createHarness();
  try {
    const now = Math.floor(Date.now() / 1000);
    const cases = {
      expired: await signToken(h.key, { exp: now - 10 }),
      wrongIssuer: await signToken(h.key, { iss: "https://evil.example" }),
      wrongAzp: await signToken(h.key, { azp: "https://evil.example" }),
      notYetValid: await signToken(h.key, { nbf: now + 600 }),
      badSubject: await signToken(h.key, { sub: "admin" }),
      foreignKey: await signToken(await createKey(h.key.jwk.kid), {})
    };
    const valid = await signToken(h.key, { sub: "user_valid" });
    const [hd, pl, sig] = valid.split(".");
    const forged = JSON.parse(Buffer.from(pl, "base64url").toString());
    forged.sub = "user_victim";
    cases.tampered = `${hd}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
    cases.malformed = "not-a-jwt";
    cases.algNone = `${Buffer.from(JSON.stringify({ alg: "none", kid: h.key.jwk.kid })).toString("base64url")}.${pl}.`;
    for (const [name, token] of Object.entries(cases)) {
      const response = await worker.fetch(new Request(`${ORIGIN}/api/me`, { headers: { authorization: `Bearer ${token}` } }), h.env, { waitUntil() {} });
      assert.equal(response.status, 401, `${name} must be rejected`);
    }
    const ok = await worker.fetch(new Request(`${ORIGIN}/api/me`, { headers: { authorization: `Bearer ${valid}` } }), h.env, { waitUntil() {} });
    assert.equal(ok.status, 200);
    const me = await ok.json();
    assert.equal(me.user.id, "user_valid");
    assert.equal(me.workspaces.length, 1);
    assert.equal(me.workspaces[0].role, "owner");
    assert.equal(me.workspaces[0].kind, "personal");
  } finally { h.restore(); }
});

test("rejects cross-origin state-changing requests (CSRF defence)", async () => {
  const h = await createHarness();
  try {
    const ws = await h.personalWorkspace("user_alice");
    const res = await h.call("user_alice", "POST", `/api/workspaces/${ws}/tasks`, { title: "Cross origin" }, { origin: "https://evil.example" });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, "origin_not_allowed");
  } finally { h.restore(); }
});

test("API responses carry security headers and a correlation id", async () => {
  const h = await createHarness();
  try {
    const res = await h.call("user_alice", "GET", "/api/me");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.ok(res.headers.get("x-correlation-id"));
    const page = await worker.fetch(new Request(`${ORIGIN}/`), h.env);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  } finally { h.restore(); }
});
