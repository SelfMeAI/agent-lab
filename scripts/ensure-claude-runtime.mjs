import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executableName, requireNativeTarget } from "../runtimes/platform.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = join(root, "runtimes/claude");
const version = JSON.parse(readFileSync(join(target, "runtime.json"), "utf8")).sdkVersion;
const platform = requireNativeTarget().key;
const source = join(root, "node_modules/@anthropic-ai", `claude-agent-sdk-${platform}`);
const sdk = join(root, "node_modules/@anthropic-ai/claude-agent-sdk");
if (!existsSync(join(source, "package.json"))) throw new Error(`缺少 Claude ${platform} 官方运行时，请运行 npm ci（不要省略 optional dependencies）`);
if (JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version !== version
  || JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).version !== version) throw new Error("Claude SDK 与官方运行时版本不匹配");
mkdirSync(join(target, "bin"), { recursive: true });
const executable = executableName("claude");
copyFileSync(join(source, executable), join(target, "bin", executable));
if (process.platform !== "win32") chmodSync(join(target, "bin", executable), 0o755);
copyFileSync(join(source, "LICENSE.md"), join(target, "LICENSE.md"));
