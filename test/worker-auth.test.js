import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker/index.js";

const env = {
  DB: {},
  CLERK_ISSUER : "https://clerk.example.test",
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
