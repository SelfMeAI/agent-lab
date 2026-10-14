import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "./source.mjs";
import { recoverManagedBrowserProfile } from "../../services/remote-agent/openclaw/bootstrap/browser-profile.mjs";

async function fixture(run) {
  const parent = join(projectRoot, ".work", "remote-agent"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "browser-profile-"));
  const home = join(root, "home"), profile = join(home, "browser", "openclaw", "user-data");
  await mkdir(profile, { recursive: true });
  try { await run({ root, home, profile }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function locks(profile, target = "old-container-1234") {
  await symlink(target, join(profile, "SingletonLock"));
  await symlink("/tmp/never-delete-this-target/SingletonSocket", join(profile, "SingletonSocket"));
  await symlink("12345678", join(profile, "SingletonCookie"));
}
test("recreated private container recovers only process locks and retains profile data", () => fixture(async ({ home, profile }) => {
  await locks(profile); await writeFile(join(profile, "Preferences"), "profile-sentinel");
  await writeFile(join(home, "openclaw.json"), "settings-sentinel");
  assert.deepEqual(await recoverManagedBrowserProfile(home, { privateVolume: true, hostname: "stable-container" }), ["SingletonSocket", "SingletonCookie", "SingletonLock"]);
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await assert.rejects(lstat(join(profile, name)), { code: "ENOENT" });
  assert.equal(await readFile(join(profile, "Preferences"), "utf8"), "profile-sentinel");
  assert.equal(await readFile(join(home, "openclaw.json"), "utf8"), "settings-sentinel");
  assert.deepEqual(await recoverManagedBrowserProfile(home, { privateVolume: true }), []);
}));
test("same-host live process lock is never cleared", () => fixture(async ({ home, profile }) => {
  await locks(profile, `stable-container-${process.pid}`);
  await assert.rejects(recoverManagedBrowserProfile(home, { privateVolume: true, hostname: "stable-container" }), /活动进程/);
  assert.equal(await readlink(join(profile, "SingletonLock")), `stable-container-${process.pid}`);
  assert.equal(await readlink(join(profile, "SingletonCookie")), "12345678");
}));
test("same-host dead process is recoverable before gateway start", () => fixture(async ({ home, profile }) => {
  await locks(profile, "stable-container-1234");
  const inspected = [];
  assert.equal((await recoverManagedBrowserProfile(home, { privateVolume: true, hostname: "stable-container", pidAlive: pid => { inspected.push(pid); return false; } })).length, 3);
  assert.deepEqual(inspected, [1234]);
}));
test("foreign lock requires explicit exclusive-volume verification", () => fixture(async ({ home, profile }) => {
  await locks(profile);
  await assert.rejects(recoverManagedBrowserProfile(home), /独占/);
  assert.equal(await readlink(join(profile, "SingletonLock")), "old-container-1234");
}));
test("unexpected regular marker or malformed lock preserves the whole set", () => fixture(async ({ home, profile }) => {
  await locks(profile, "malformed-lock");
  await assert.rejects(recoverManagedBrowserProfile(home, { privateVolume: true }), /格式异常/);
  assert.equal(await readlink(join(profile, "SingletonCookie")), "12345678");
  await rm(join(profile, "SingletonCookie")); await writeFile(join(profile, "SingletonCookie"), "not-a-marker");
  await assert.rejects(recoverManagedBrowserProfile(home, { privateVolume: true }), /符号链接/);
  assert.equal(await readFile(join(profile, "SingletonCookie"), "utf8"), "not-a-marker");
  assert.equal(await readlink(join(profile, "SingletonLock")), "malformed-lock");
}));
test("profile paths cannot escape the private volume through symlinks", () => fixture(async ({ root, home, profile }) => {
  const external = join(root, "outside"); await mkdir(external); await locks(external);
  await rm(profile, { recursive: true }); await symlink(external, profile, 'dir');
  await assert.rejects(recoverManagedBrowserProfile(home, { privateVolume: true }), /越界/);
  assert.equal(await readlink(join(external, "SingletonLock")), "old-container-1234");
}));
