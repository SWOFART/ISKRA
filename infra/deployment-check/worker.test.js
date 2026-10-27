import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.js";

test("health identifies the deployed release without claiming the application exists", async () => {
  const response = worker.fetch(new Request("https://example.test/api/health"), {
    RELEASE_SHA: "test-commit",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "iskra-deployment-check",
    applicationReady: false,
    release: "test-commit",
  });
});

test("unknown paths return a JSON 404", async () => {
  const response = worker.fetch(new Request("https://example.test/api/reports"), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "NOT_FOUND" });
});

test("mutation requests are not accepted", async () => {
  const response = worker.fetch(
    new Request("https://example.test/api/health", { method: "POST" }),
    {},
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "GET");
});
