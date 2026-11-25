import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";

const env = {
  DB: {},
  CLERK_ISSUER: "https://clerk.example.test",
  CLERK_JWKS_URL: "https://clerk.example.test/.well-known/jwks.json"
};

test("keeps the health endpoint public", async () => {
  const response = await worker.fetch(new Request("https://workspace.example.test/api/health"), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("exposes only public Clerk frontend configuration", async () => {
  const response = await worker.fetch(new Request("https://workspace.example.test/api/config"), {
    CLERK_PUBLISHABLE_KEY: "pk_test_public",
    CLERK_FRONTEND_API_URL: "https://clerk.example.test"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    publishableKey: "pk_test_public",
    frontendApiUrl: "https://clerk.example.test"
  });
});

test("rejects protected API requests before accessing the database when no session is supplied", async () => {
  const response = await worker.fetch(new Request("https://workspace.example.test/api/tasks"), env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Sign in to access this workspace." });
});

test("scopes the task list query to the verified Clerk subject", async () => {
  const encoder = new TextEncoder();
  const toBase64Url = (bytes) => Buffer.from(bytes).toString("base64url");
  const encodeJson = (value) => toBase64Url(encoder.encode(JSON.stringify(value)));
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwk.kid = "owner-test-key";
  jwk.use = "sig";
  const header = encodeJson({ alg: "RS256", kid: jwk.kid, typ: "JWT" });
  const payload = encodeJson({
    iss: "https://clerk.example.test", sub: "user_owner123", sid: "sess_owner123",
    exp: Math.floor(Date.now() / 1000) + 300, azp: "https://workspace.example.test"
  });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, encoder.encode(signingInput));
  const token = `${signingInput}.${toBase64Url(signature)}`;
  const originalFetch = globalThis.fetch;
  const calls = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) { this.values = values; calls.push({ sql, values }); return this; },
        async all() { return { results: [] }; }
      };
      return statement;
    }
  };
  const jwksUrl = `https://clerk.example.test/${crypto.randomUUID()}/.well-known/jwks.json`;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200, headers: { "content-type": "application/json" }
  });
  try {
    const response = await worker.fetch(new Request("https://workspace.example.test/api/tasks", {
      headers: { authorization: `Bearer ${token}` }
    }), { ...env, DB: db, CLERK_JWKS_URL: jwksUrl });
    assert.equal(response.status, 200);
    assert.match(calls[0].sql, /WHERE owner_id = \\?/);
    assert.deepEqual(calls[0].values, ["user_owner123"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
