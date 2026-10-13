import { accessSync, constants } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The foreground app binary is not a headless Node launcher on macOS. */
export function harnessNodeExecutable(executable: string, platform = process.platform): string {
  if (platform !== "darwin") return executable;
  const macos = dirname(executable), contents = dirname(macos);
  if (basename(macos) !== "MacOS" || basename(contents) !== "Contents") {
    throw new Error("无法定位 macOS 后台运行器，请从完整的 Agent Lab.app 启动");
  }
  // electron-builder names both executables from productName, not npm's name
  // or app.getName(). This also resolves Electron Helper in development.
  const name = `${basename(executable)} Helper`;
  const helper = join(contents, "Frameworks", `${name}.app`, "Contents", "MacOS", name);
  try { accessSync(helper, constants.X_OK); }
  catch { throw new Error(`后台运行器缺失或不可执行，请重新打包：${helper}`); }
  // Do not fall back to the foreground binary: every harness/session can then
  // create another inert, bouncing Dock icon. Helpers carry LSUIElement=true.
  return helper;
}
