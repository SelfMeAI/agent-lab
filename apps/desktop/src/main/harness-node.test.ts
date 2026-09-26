import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessNodeExecutable } from "./harness-node";

describe("headless harness Node executable", () => {
  it.each(["SelfMe Lab", "Electron"])("uses the background Helper for %s, independently of npm/app names", async name => {
    await mkdir(".work", { recursive: true });
    const scratch = await mkdtemp(join(".work", "helper-path-"));
    const contents = join(scratch, `${name}.app`, "Contents");
    const executable = join(contents, "MacOS", name);
    const helper = join(contents, "Frameworks", `${name} Helper.app`, "Contents", "MacOS", `${name} Helper`);
    try {
      await mkdir(join(contents, "MacOS"), { recursive: true });
      await mkdir(join(helper, ".."), { recursive: true });
      await writeFile(helper, "test-only executable", { mode: 0o700 });
      expect(harnessNodeExecutable(executable, "darwin")).toBe(helper);
      await chmod(helper, 0o600);
      expect(() => harnessNodeExecutable(executable, "darwin")).toThrow(/不可执行/);
      await rm(helper);
      expect(() => harnessNodeExecutable(executable, "darwin")).toThrow(/重新打包/);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
  it("fails closed on a malformed macOS app layout rather than launching a GUI process", () => {
    expect(() => harnessNodeExecutable("/Applications/SelfMe Lab", "darwin")).toThrow(/完整/);
  });
  it.each(["win32", "linux"] as const)("keeps the existing %s Node-mode launch", platform => {
    expect(harnessNodeExecutable("/path/to/executable", platform)).toBe("/path/to/executable");
  });
});
