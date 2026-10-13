import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "./process.mjs";

export async function sha256(path) {
  return digest(path, "sha256", "hex");
}

export async function digest(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}

export async function hasChecksum(path, expected) {
  try { return await sha256(path) === expected; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function downloadVerified(url, path, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected) || new URL(url).protocol !== "https:") throw new Error("下载必须使用 HTTPS 和固定 SHA-256");
  return downloadChecked(url, path, async file => hasChecksum(file, expected));
}

export async function downloadNpmArchive(url, path, integrity) {
  if (!url.startsWith("https://registry.npmjs.org/") || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error("npm 运行包必须来自官方 registry 且具有固定 SHA-512 SRI");
  return downloadChecked(url, path, async file => {
    try { return `sha512-${await digest(file, "sha512", "base64")}` === integrity; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
}

async function downloadChecked(url, path, valid) {
  if (await valid(path)) return path;
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.part`;
  let resume = false;
  try { resume = (await lstat(partial)).isFile(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  // curl uses the user's existing proxy environment. Never change proxy/DNS
  // settings, and do not promote a partial archive until its digest matches.
  await run("curl", ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
    "--retry", "3", "--connect-timeout", "30", ...(resume ? ["--continue-at", "-"] : []), "--output", partial, url], { timeout: 1_800_000 });
  if (!(await valid(partial))) {
    await rm(partial, { force: true });
    throw new Error(`下载校验失败，未安装：${new URL(url).pathname.split("/").at(-1)}`);
  }
  await rename(partial, path);
  return path;
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function copyAtomic(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { await copyFile(source, temporary); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
}

export async function verifyFileHashes(directory, hashes, required) {
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) throw new Error("运行时缺少文件校验记录");
  for (const path of required) if (!Object.hasOwn(hashes, path)) throw new Error(`运行时缺少必要文件记录：${path}`);
  for (const [path, expected] of Object.entries(hashes)) {
    if (!/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(path) || path.split("/").some(part => part === "..") || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("运行时文件校验记录无效");
    const file = join(directory, path), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || !(await hasChecksum(file, expected))) throw new Error(`运行时文件校验失败：${path}`);
  }
}

export async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
