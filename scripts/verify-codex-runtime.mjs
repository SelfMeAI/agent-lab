import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtime = join(root, "runtimes", "codex");
const source = JSON.parse(await readFile(join(runtime, "source.json"), "utf8"));

for (const [relativePath, expected] of Object.entries(source.sha256)) {
  const path = join(runtime, relativePath);
  await access(path, constants.X_OK);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error(`Codex 运行时校验失败：${relativePath}`);
}

const packageMarker = JSON.parse(await readFile(join(runtime, "codex-package.json"), "utf8"));
if (packageMarker.version !== source.version || packageMarker.target !== source.target) {
  throw new Error("Codex 运行时包布局与源码记录不匹配");
}
console.log(`Codex ${source.version} (${source.target}) 运行时校验通过`);
