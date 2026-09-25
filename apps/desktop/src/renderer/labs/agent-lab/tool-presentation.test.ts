import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "./agent-store";
import { presentEntry, visibleTranscriptEntries } from "./tool-presentation";

function entry(raw: unknown, overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { id: "1", kind: "tool", runId: "run-1", text: "", at: "2026-09-25T00:00:00Z", raw, ...overrides };
}

describe("agent tool presentation", () => {
  it("shows Codex file changes with truthful add/remove counts", () => {
    const view = presentEntry(entry({ type: "fileChange", changes: [{
      path: "src/app.ts", kind: { type: "update" },
      diff: "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n unchanged\n",
    }] }));
    expect(view.summary).toBe("1 个文件 · +1 −1");
    expect(view.files[0].lines.map((line) => line.kind)).toEqual(["header", "remove", "add", "context"]);
  });

  it("shows ACP text diffs without treating unchanged lines as edits", () => {
    const view = presentEntry(entry({
      kind: "edit", content: [{ type: "diff", path: "notes.txt", oldText: "same\nold\nend\n", newText: "same\nnew\nend\n" }],
    }));
    expect(view.label).toBe("编辑文件");
    expect(view.files[0]).toMatchObject({ path: "notes.txt", added: 1, removed: 1 });
  });

  it("keeps an unchanged middle line as context when edits occur at both ends", () => {
    const view = presentEntry(entry({ kind: "edit", content: [{ type: "diff", path: "sample.txt", oldText: "旧标题\n保持这一行\n", newText: "新标题\n保持这一行\n测试完成\n" }] }));
    expect(view.summary).toBe("1 个文件 · +2 −1");
    expect(view.files[0].lines.map((line) => line.text)).toEqual(["-旧标题", "+新标题", " 保持这一行", "+测试完成"]);
  });

  it("splits Codex turn-level diffs into files and counts additions and removals", () => {
    const view = presentEntry(entry({ type: "turnDiff", diff: [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/notes.txt b/notes.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/notes.txt",
      "@@ -0,0 +1 @@",
      "+hello",
    ].join("\n") }));
    expect(view.label).toBe("本轮文件变更");
    expect(view.summary).toBe("2 个文件 · +2 −1");
    expect(view.files.map((file) => [file.path, file.action])).toEqual([["src/app.ts", "修改"], ["notes.txt", "新增"]]);
    expect(view.files[0].lines.some((line) => line.kind === "remove" && line.text === "-old")).toBe(true);
    expect(view.files[1].lines.some((line) => line.kind === "add" && line.text === "+hello")).toBe(true);
    expect(view.files[0].lines.some((line) => line.text.startsWith("diff --git"))).toBe(false);
  });

  it("replaces per-tool Codex file cards with the turn-level diff without hiding command actions", () => {
    const individual = entry({ type: "fileChange", changes: [{ path: "a.txt", diff: "+new" }] }, { id: "file", runId: "run-1" });
    const command = entry({ type: "commandExecution", command: "git status" }, { id: "command", runId: "run-1" });
    const aggregate = entry({ type: "turnDiff", diff: "diff --git a/a.txt b/a.txt\n@@ -0,0 +1 @@\n+new\n" }, { id: "aggregate", runId: "run-1" });
    const otherRun = entry({ type: "fileChange", changes: [] }, { id: "other", runId: "run-2" });
    expect(visibleTranscriptEntries([individual, command, aggregate, otherRun]).map((item) => item.id)).toEqual(["command", "aggregate", "other"]);
  });

  it("presents commands and plans without raw JSON", () => {
    const command = presentEntry(entry({ type: "commandExecution", command: "npm test", cwd: "/work", exitCode: 0, durationMs: 1900, aggregatedOutput: "2 passed" }));
    expect(command).toMatchObject({ label: "执行命令", command: "npm test", cwd: "/work", exitCode: 0, duration: "1.9s", output: "2 passed" });
    expect(presentEntry(entry({ type: "commandExecution", durationMs: 0 })).duration).toBe("<0.1s");
    const plan = presentEntry(entry({ plan: [{ step: "检查目录", status: "completed" }, { step: "修复样式", status: "inProgress" }] }, { kind: "status" }));
    expect(plan.plan).toHaveLength(2);
  });

  it("turns DSH read wrappers into a clear action, path and file content", () => {
    const view = presentEntry(entry({ kind: "other" }, {
      title: "read",
      text: "<path>/work/package.json</path>\n<type>file</type>\n<content>\n1: {\n2:   \"name\": \"demo\"\n</content>",
      toolStatus: "completed",
    }));
    expect(view).toMatchObject({ label: "读取文件", summary: "/work/package.json", status: "已完成", output: "1: {\n2:   \"name\": \"demo\"" });
  });

  it("shows DSH command intent and edit target instead of opaque tool names", () => {
    const command = presentEntry(entry({ kind: "other", rawInput: { command: "ls -la", description: "检查目录" } }, { title: "bash", text: "total 8" }));
    expect(command).toMatchObject({ label: "执行命令", summary: "检查目录", command: "ls -la" });
    const edit = presentEntry(entry({ kind: "other", rawInput: { file_path: "sample.txt" } }, { title: "edit", text: "updated successfully" }));
    expect(edit).toMatchObject({ label: "编辑文件", summary: "sample.txt" });
  });
});
