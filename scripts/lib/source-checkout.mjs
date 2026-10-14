import { lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { run } from "./process.mjs";

export async function ensureCheckout({ repository, commit, directory, root, verifyOnly = false, submodules = false, platform = process.platform }) {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.git$/.test(repository)
    || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("源码必须使用明确的 GitHub 仓库和固定提交");
  const base = resolve(root), target = resolve(directory), path = relative(base, target);
  if (!path || isAbsolute(path) || path.startsWith(`..${sep}`) || path === ".." || resolve(base, path) !== target) throw new Error("源码缓存必须位于项目目录内");
  for (let cursor = target; cursor !== base; cursor = dirname(cursor)) {
    try { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`源码缓存不能经过文件或符号链接：${cursor}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  let initialized = false;
  try { const info = await lstat(resolve(target, ".git")); initialized = info.isDirectory() && !info.isSymbolicLink(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!initialized) {
    if (verifyOnly) throw new Error(`源码尚未准备：${target}`);
    try { if ((await readdir(target)).length) throw new Error(`已有目录不是独立源码仓库，未覆盖：${target}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await mkdir(target, { recursive: true });
    await run("git", ["init", "--quiet"], { cwd: target });
    await run("git", ["remote", "add", "origin", repository], { cwd: target });
  }
  const capture = args => run("git", args, { cwd: target, capture: true });
  if (await capture(["remote", "get-url", "origin"]) !== repository) throw new Error("源码仓库来源不匹配，未修改");
  if (await capture(["status", "--porcelain", "--untracked-files=all"])) throw new Error("源码缓存中存在修改，未覆盖；请把二次开发保留为项目内的补丁或扩展");
  let actual = "";
  try { actual = await capture(["rev-parse", "--verify", "HEAD"]); } catch { /* an interrupted first fetch is retryable */ }
  if (actual && actual !== commit) throw new Error("源码缓存的固定提交不匹配，未切换或覆盖");
  // Codex has snapshot filenames exceeding Git for Windows' default MAX_PATH.
  // Configure only this verified, project-owned cache repo. Linked worktrees
  // inherit it; never change the user's global Git config or OS registry.
  if (!verifyOnly && platform === "win32") await capture(["config", "--local", "core.longpaths", "true"]);
  if (!actual) {
    if (verifyOnly) throw new Error("源码首次获取尚未完成");
    await run("git", ["fetch", "--depth", "1", "origin", commit], { cwd: target });
    await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: target });
  }
  if (await capture(["rev-parse", "HEAD"]) !== commit) throw new Error("源码固定提交校验失败");
  if (submodules && !verifyOnly) await run("git", ["submodule", "update", "--init", "--recursive", "--depth", "1"], { cwd: target, timeout: 1_800_000 });
  return target;
}
