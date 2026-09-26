import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../contracts/src/index";
import { SteeringTracker, steeringError } from "./steering";

describe("native steering receipts", () => {
  it("redacts a provider key before persisting a failed steering receipt or returning an IPC error", () => {
    expect(steeringError(new Error("request sk-example failed"), "sk-example").message).toBe("request [redacted] failed");
  });
  it("never downgrades a consumption receipt when it arrives before the request ack", () => {
    const events: Partial<RunEvent>[] = [];
    const tracker = new SteeringTracker((event) => events.push(event));
    tracker.begin("one", "new requirement");
    tracker.incorporated("one");
    tracker.accepted("one");
    tracker.finish();
    expect(events.map((event) => event.deliveryState)).toEqual(["incorporated"]);
  });
  it("matches identical text FIFO, caps native pending inputs and never auto-replays", () => {
    const events: Partial<RunEvent>[] = [];
    const tracker = new SteeringTracker((event) => events.push(event));
    for (let i = 0; i < 10; i++) tracker.begin(String(i), "same");
    expect(() => tracker.begin("overflow", "extra")).toThrow(/10/);
    tracker.match("same");
    tracker.match("same");
    expect(events.map((event) => event.messageId)).toEqual(["0", "1"]);
    tracker.finish();
    expect(events.slice(2).every((event) => event.deliveryState === "unconfirmed")).toBe(true);
    tracker.begin("next", "next");
  });
});
