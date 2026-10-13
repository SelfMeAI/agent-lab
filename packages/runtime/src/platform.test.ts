import { describe, expect, it } from "vitest";
import { executableName, requireNativeTarget, runtimeTarget, runtimeTargets } from "../../../runtimes/platform.mjs";

describe("shared desktop runtime targets", () => {
  it("maps all supported 64-bit hosts to explicit Rust and Linux container architectures", () => {
    expect(runtimeTargets).toHaveLength(6);
    expect(runtimeTarget("darwin", "arm64")).toMatchObject({ key: "darwin-arm64", rustTarget: "aarch64-apple-darwin", dockerPlatform: "linux/arm64" });
    expect(runtimeTarget("darwin", "x64").rustTarget).toBe("x86_64-apple-darwin");
    expect(runtimeTarget("win32", "x64").rustTarget).toBe("x86_64-pc-windows-msvc");
    expect(runtimeTarget("win32", "arm64").rustTarget).toBe("aarch64-pc-windows-msvc");
    expect(runtimeTarget("linux", "x64").dockerPlatform).toBe("linux/amd64");
    expect(runtimeTarget("linux", "arm64").rustTarget).toBe("aarch64-unknown-linux-gnu");
  });
  it("uses real Windows executable names without changing Unix names", () => {
    for (const name of ["codex", "codex-code-mode-host", "rg", "ollama", "claude"]) {
      expect(executableName(name, "win32")).toBe(`${name}.exe`);
      expect(executableName(name, "darwin")).toBe(name);
      expect(executableName(name, "linux")).toBe(name);
    }
    expect(() => executableName("../codex", "win32")).toThrow();
    expect(() => executableName("codex.exe", "win32")).toThrow();
  });
  it("rejects unsupported architectures and accidentally packaged foreign binaries", () => {
    expect(() => runtimeTarget("win32", "ia32")).toThrow();
    expect(() => runtimeTarget("linux", "arm")).toThrow();
    expect(() => requireNativeTarget()).not.toThrow();
    const foreign = process.platform === "win32" ? "darwin" : "win32";
    expect(() => requireNativeTarget(foreign, "x64")).toThrow(/原生构建机/);
  });
});
