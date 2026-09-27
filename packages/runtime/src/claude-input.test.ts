import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ClaudeInput } from "./claude-input";

describe("Claude streaming input", () => {
  it("keeps input open between turns and discards buffered input on close", async () => {
    const input = new ClaudeInput(), iterator = input[Symbol.asyncIterator]();
    const message = { type: "user" as const, message: { role: "user" as const, content: "first" }, parent_tool_use_id: null, uuid: randomUUID() };
    const next = iterator.next(); input.push(message);
    expect(await next).toEqual({ done: false, value: message });
    input.push(message); input.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(() => input.push(message)).toThrow(/关闭/);
  });
  it("unblocks a pending read when stopped", async () => {
    const input = new ClaudeInput(), next = input[Symbol.asyncIterator]().next();
    input.close(); expect((await next).done).toBe(true);
  });
});
