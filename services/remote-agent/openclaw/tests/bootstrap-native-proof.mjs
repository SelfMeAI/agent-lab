import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** Only adapt the upstream test bootstrap; all native RPC/assertions remain intact.
 * The Docker release build selects plugins. The development run-node launcher
 * instead scans every source plugin and would rebuild unrelated plugins here.
 */
export function useBuiltLauncher(source) {
  const before = 'spawn(process.execPath, ["scripts/run-node.mjs", "gateway", "run"], {';
  const after = 'spawn(process.execPath, ["openclaw.mjs", "gateway", "run"], {';
  if (source.split(before).length !== 2) throw new Error("官方桌面测试的启动点已改变，请重新核对，未自动改写");
  return source.replace(before, after);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = await readFile("/app/scripts/dev/computer-use-gateway-live-proof.ts", "utf8");
  await writeFile("/app/scripts/dev/agent-lab-gateway-desktop-proof.ts", useBuiltLauncher(source), { flag: "wx" });
}
