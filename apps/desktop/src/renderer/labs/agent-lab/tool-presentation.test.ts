import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "./agent-store";
import { presentEntry } from "./tool-presentation";

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

  it("presents commands and plans without raw JSON", () => {
    const command = presentEntry(entry({ type: "commandExecution", command: "npm test", cwd: "/work", exitCode: 0, durationMs: 1900, aggregatedOutput: "2 passed" }));
    expect(command).toMatchObject({ label: "执行命令", command: "npm test", cwd: "/work", exitCode: 0, duration: "1.9s", output: "2 passed" });
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
});
