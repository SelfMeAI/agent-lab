import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const phase = process.argv[2];
if (phase !== "before" && phase !== "after") {
  throw new Error("Usage: clean-mac-output.mjs before|after");
}

const release = join(dirname(dirname(fileURLToPath(import.meta.url))), "release");
const targets = phase === "before"
  ? ["mac-arm64", "mac-arm64.tmp"]
  : ["mac-arm64.tmp", ".icon-icns", "builder-debug.yml"];

for (const target of targets) {
  await rm(join(release, target), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
