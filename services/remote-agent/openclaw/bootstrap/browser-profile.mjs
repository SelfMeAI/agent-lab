import { lstat, readlink, realpath, unlink } from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import { join, resolve, sep } from "node:path";

const markers = ["SingletonSocket", "SingletonCookie", "SingletonLock"];
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};

/** Run BEFORE the gateway starts, only in its verified exclusive Docker volume.
 * Recover Chromium's process-local symlinks, never cookies/history/profile data.
 * A recreated container cannot own the old container's host/pid lock. Giving
 * future containers a stable hostname also lets native Chromium recovery work.
 */
export async function recoverManagedBrowserProfile(home, {
  privateVolume = false, hostname = systemHostname(), pidAlive = alive,
} = {}) {
  const root = await realpath(home);
  if (root !== resolve(home)) throw new Error("浏览器服务卷路径异常，未清理锁");
  const profile = join(root, "browser", "openclaw", "user-data");
  let canonical;
  try { canonical = await realpath(profile); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (canonical !== profile || !canonical.startsWith(root + sep)) throw new Error("浏览器配置目录越界，未清理锁");
  const existing = [];
  for (const name of markers) {
    const path = join(profile, name);
    let info;
    try { info = await lstat(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!info.isSymbolicLink()) throw new Error("浏览器锁不是预期的符号链接，未作修改");
    existing.push({ name, path, target: await readlink(path), ino: info.ino });
  }
  const lock = existing.find(marker => marker.name === "SingletonLock");
  if (!lock) return [];
  if (!privateVolume) throw new Error("未确认浏览器服务卷独占，未清理锁");
  const match = /^([a-zA-Z0-9][a-zA-Z0-9.-]*)-([1-9][0-9]*)$/.exec(lock.target);
  const pid = match && Number(match[2]);
  if (!match || !Number.isSafeInteger(pid) || pid > 2_147_483_647) throw new Error("浏览器进程锁格式异常，未作修改");
  if (match[1] === hostname && pidAlive(pid)) throw new Error("浏览器锁仍由活动进程持有，未作修改");
  // Validate the entire set again before unlinking anything. Never follow a
  // SingletonSocket target into /tmp or remove an unexpected regular file.
  for (const marker of existing) {
    const info = await lstat(marker.path);
    if (!info.isSymbolicLink() || info.ino !== marker.ino || await readlink(marker.path) !== marker.target) throw new Error("浏览器锁在检查后发生变化，未作修改");
  }
  for (const marker of existing) await unlink(marker.path);
  return existing.map(marker => marker.name);
}
