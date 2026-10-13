import { test } from "node:test";
import assert from "node:assert/strict";
import { secretKinds } from "./check-source.mjs";

test("source scan redacts values, allows only obvious test fixtures and does not exempt opaque tokens", () => {
  const opaque = "sk-" + "a1".repeat(20), fixture = "sk-local-example-question-fixture";
  assert.deepEqual(secretKinds(opaque, "example.test.ts"), ["api-key"]);
  assert.deepEqual(secretKinds(fixture, "example.test.ts"), []);
  assert.deepEqual(secretKinds(fixture, "src/main.ts"), ["api-key"]);
  assert.deepEqual(secretKinds("-----BEGIN " + "PRIVATE KEY-----", "file.txt"), ["private-key"]);
});
