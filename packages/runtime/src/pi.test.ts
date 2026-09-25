import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "./pi";

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("Pi file-tool workspace boundary", () => {
  it("normalizes safe paths and rejects traversal and symlink escapes", async () => {
    root = await mkdtemp(join(tmpdir(), "selfme-pi-path-"));
    const workspaceDirectory = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspaceDirectory);
    await mkdir(outside);
    const workspace = await realpath(workspaceDirectory);
    await writeFile(join(workspace, "inside.txt"), "safe");
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(workspace, "outside-link"));
    await symlink(join(outside, "not-yet-created.txt"), join(workspace, "dangling-link"));

    expect(await resolveWorkspacePath(workspace, "inside.txt", true)).toBe(join(workspace, "inside.txt"));
    expect(await resolveWorkspacePath(workspace, "new.txt")).toBe(join(workspace, "new.txt"));
    expect(await resolveWorkspacePath(workspace, "~/literal.txt")).toBe(join(workspace, "~", "literal.txt"));
    expect(await resolveWorkspacePath(workspace, "@literal.txt")).toBe(join(workspace, "@literal.txt"));
    await expect(resolveWorkspacePath(workspace, "../outside/secret.txt", true)).rejects.toThrow("工作目录");
    await expect(resolveWorkspacePath(workspace, "outside-link/secret.txt", true)).rejects.toThrow("符号链接");
    await expect(resolveWorkspacePath(workspace, "outside-link/new.txt")).rejects.toThrow("符号链接");
    await expect(resolveWorkspacePath(workspace, "dangling-link")).rejects.toThrow("悬空符号链接");
  });
});
