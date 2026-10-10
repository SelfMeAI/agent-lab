import { describe, expect, it } from "vitest";
import { isTerminalProtocolReply } from "./terminal-response";

describe("terminal attachment protocol replies", () => {
  it.each(["\x1b[>0;276;0c", "\x1b[?1;2c", "\x1b[?2026;2$y", "\x1b]11;rgb:0606/0b0b/0f0f\x1b\\", "\x1b]4;0;rgb:00/00/00\x07"])("routes %j to the observing attachment, not the human shell", reply => {
    expect(isTerminalProtocolReply(reply)).toBe(true);
  });
  it.each(["pwd\r", "\x03", "\x1b[A", "\x1bOR", "\x1b[>0;276;0cpwd\r", "\x1b]52;c;cHdk\x07", "\x1b[>0;276;0c\x1b[?1;2c", "\x1b[>" + "1;".repeat(70) + "0c", undefined])("does not admit normal input or mixed payload %j as protocol", data => {
    expect(isTerminalProtocolReply(data)).toBe(false);
  });
});
