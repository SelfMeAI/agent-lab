import { describe, expect, it } from "vitest";
import { labOpenClawTaskId, openClawTaskPrefix, isLabPrivateFile } from "./identity";
import { remoteTaskId } from "./transport/http";

const id = "c0ec83da-66be-4f17-a2c2-01dc02c89f00";
describe("durable task identity during application rename", () => {
  it("uses the full new name and recognizes original native histories", () => {
    expect(labOpenClawTaskId(openClawTaskPrefix + id)).toBe(id);
    expect(labOpenClawTaskId("agent:main:selfme:" + id)).toBe(id);
    expect(remoteTaskId("agent:main:selfme:" + id)).toBe(id);
    expect(remoteTaskId(id)).toBe(id);
  });
  it("rejects another agent, group, injected prefixes and malformed UUIDs", () => {
    for (const value of ["agent:other:agent-lab:" + id, "untrusted:agent-lab:" + id, openClawTaskPrefix + id + ":other", id, openClawTaskPrefix + "invalid"]) expect(labOpenClawTaskId(value)).toBeNull();
    expect(() => remoteTaskId("untrusted:agent-lab:" + id)).toThrow();
  });
  it("keeps both old and new internal files out of task file APIs", () => {
    expect(isLabPrivateFile(".selfme-workspace")).toBe(true);
    expect(isLabPrivateFile(".agent-lab-workspace")).toBe(true);
    expect(isLabPrivateFile("document.txt")).toBe(false);
  });
});
