import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkspaceLock } from "./codex-lock.mjs";

test("release lock normalization changes only workspace package versions and their disambiguated references", () => {
  const lock = 'version = 4\n\n[[package]]\nname = "local"\nversion = "0.0.0"\ndependencies = [\n "other 0.0.0",\n]\n\n[[package]]\nname = "other"\nversion = "0.0.0"\n\n[[package]]\nname = "registry"\nversion = "0.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "unchanged"\n';
  const packages = [{ name: "local", version: "0.153.4", source: null }, { name: "other", version: "0.153.4", source: null }];
  const expected = lock.replace('name = "local"\nversion = "0.0.0"', 'name = "local"\nversion = "0.153.4"').replace('name = "other"\nversion = "0.0.0"', 'name = "other"\nversion = "0.153.4"').replace('"other 0.0.0"', '"other 0.153.4"');
  assert.equal(normalizeWorkspaceLock(lock, packages), expected);
  assert.equal(normalizeWorkspaceLock(expected, packages), expected);
});
