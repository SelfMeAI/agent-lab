import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "./lib/process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const forbidden = /^(?:node_modules\/|(?:\.cache|\.work|release|output\/playwright)\/|runtimes\/(?:codex\/(?:bin|codex-path|codex-resources)\/|claude\/bin\/|ollama\/native\/)|services\/remote-agent\/[^/]+\/upstream\/)|\.(?:sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?|gguf|safetensors|pem|key)$/i;
export function secretKinds(text, path) {
  const result = [];
  if (/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text)) result.push("private-key");
  const tokens = text.match(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/g) ?? [];
  const testFile = /(?:\.test\.|\/tests\/|\/test-support\/)/.test(path);
  // Only clearly named, hyphenated fake fixture tokens are allowed in tests.
  // Opaque/hex vendor credentials are never exempted, even in test files.
  if (tokens.some(token => !(testFile && /^sk-(?=[a-z-]*\b(?:local|test|mock|fixture)\b)[a-z]+(?:-[a-z]+)+$/.test(token)))) result.push("api-key");
  if (/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}\b/.test(text)) result.push("github-token");
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) result.push("aws-access-key");
  return result;
}

export async function checkSource() {
  const names = (await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, capture: true, maxBuffer: 1_000_000 })).split("\0").filter(Boolean);
  const issues = [];
  for (const path of new Set(names)) {
    if (forbidden.test(path) || /(?:^|\/)\.env(?:\..+)?$/.test(path) && !path.endsWith(".env.example")) issues.push(`${path} · generated-or-personal-data`);
    if (!/\.(?:[cm]?[jt]sx?|json|toml|ya?ml|md|txt|py|sh|ps1|html|css|xml)$/.test(path) && !/(?:^|\/)(?:LICENSE|NOTICE|Dockerfile|\.npmrc)$/.test(path)) continue;
    try {
      const value = await readFile(join(root, path), "utf8");
      for (const kind of secretKinds(value, path)) issues.push(`${path} · ${kind}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (issues.length) throw new Error(`源码发布检查未通过（不输出敏感值）：\n${issues.join("\n")}`);
  console.log(`源码发布检查通过 · ${new Set(names).size} 个文件 · 未检测到所检查类型的凭据或个人/生成数据。\n此检查不能替代人工审核或专用秘密扫描。`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkSource().catch(error => { console.error(error.message); process.exitCode = 1; });
}
