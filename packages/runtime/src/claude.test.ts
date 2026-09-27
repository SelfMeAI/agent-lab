import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../contracts/src/index";
import { ClaudeAdapter } from "./claude";

function fixture() {
  const adapter = new ClaudeAdapter({ executable: "unused", homeDirectory: "unused", provider: async () => ({ apiKey: "", baseUrl: "", model: "" }) });
  const events: RunEvent[] = []; adapter.onEvent(e => events.push(e));
  const native = adapter as unknown as { phase: string; apiKey: string; handleMessage(value: unknown): void; beginTool(id: string, name: string, input: object): void; finishTool(id: string, result: unknown, failed: boolean): void };
  native.phase = "running";
  return { events, native };
}

describe("Claude native event presentation", () => {
  it("deduplicates interleaved main/subagent streaming blocks", () => {
    const { events, native } = fixture();
    for (const [parent, id] of [[null, "main"], ["agent-tool", "child"]]) native.handleMessage({ type: "stream_event", parent_tool_use_id: parent, event: { type: "message_start", message: { id } } });
    for (const [parent, content] of [[null, "主输出"], ["agent-tool", "子输出"]]) native.handleMessage({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } } });
    for (const [id, content] of [["main", "主输出"], ["child", "子输出"]]) native.handleMessage({ type: "assistant", message: { id, content: [{ type: "text", text: content }] } });
    expect(events.map(e => e.text)).toEqual(["主输出", "子输出"]);
  });
  it("waits for background work and ignores ambient tasks without getting stuck", () => {
    const { events, native } = fixture();
    native.handleMessage({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "work" }, { task_id: "watcher", ambient: true }] });
    native.handleMessage({ type: "result", subtype: "success", is_error: false, queued_turn_count: 0 });
    expect(events.some(e => e.phase === "ready")).toBe(false);
    native.handleMessage({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "watcher", ambient: true }] });
    expect(events.filter(e => e.phase === "ready")).toHaveLength(1);
  });
  it("shows native read results and scrubs credentials from all event payloads", () => {
    const { events, native } = fixture(); native.apiKey = "secret-to-scrub";
    native.beginTool("read-1", "Read", { file_path: "readme.txt" });
    native.finishTool("read-1", { type: "text", file: { content: "hello secret-to-scrub" } }, false);
    expect(events.at(-1)).toMatchObject({ text: "hello [redacted]", toolStatus: "completed" });
    expect(JSON.stringify(events)).not.toContain("secret-to-scrub");
  });
});
