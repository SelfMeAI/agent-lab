import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileChangeTracker } from "./file-change-tracker";

describe("DSH file change tracking", () => {
  it("returns an actual before/after diff for edits, even when the ACP start event arrives late", () => {
    const workspace = mkdtempSync(join(tmpdir(), "selfme-diff-test-"));
    try {
      writeFileSync(join(workspace, "sample.txt"), "旧标题\n保持这一行\n");
      const path = realpathSync(join(workspace, "sample.txt"));
      const tracker = new FileChangeTracker(workspace);
      tracker.start("read-1", "read", { file_path: path });
      tracker.start("edit-1", "edit", { file_path: path });
      writeFileSync(path, "新标题\n保持这一行\n");
      expect(tracker.finish("edit-1", true)).toEqual({ type: "diff", path, oldText: "旧标题\n保持这一行\n", newText: "新标题\n保持这一行\n" });

      tracker.start("read-2", "read", { file_path: path });
      writeFileSync(path, "新标题\n保持这一行\n测试完成\n");
      tracker.start("edit-2", "edit", { file_path: path });
      expect(tracker.finish("edit-2", true)).toEqual({ type: "diff", path, oldText: "新标题\n保持这一行\n", newText: readFileSync(path, "utf8") });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not inspect paths outside the selected workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "selfme-diff-test-"));
    try {
      const tracker = new FileChangeTracker(workspace);
      tracker.start("edit-1", "edit", { file_path: "../outside.txt" });
      expect(tracker.finish("edit-1", true)).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
