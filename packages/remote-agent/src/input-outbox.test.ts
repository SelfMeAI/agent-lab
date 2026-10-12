import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { InputQueue, type InputDriver, type NativeState } from "../../../services/remote-agent/openclaw/plugin/input-queue";
import { mergeRemoteInputQueue, remoteInputQueue, remoteSendOptions } from "./input-queue";

const stores: InputQueue[] = [], folders: string[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true }); });
function fixture(path = ":memory:") {
  let status: NativeState = "running", reject = false;
  const receipts = new Map<string, "consumed" | "pending" | "interrupted" | "absent">();
  const driver: InputDriver = {
    state: vi.fn(async () => status), receipt: vi.fn(async (_task, id) => receipts.get(id) ?? "absent"),
    send: vi.fn(async (_task, _body, id, _steer, current) => { if (!current()) throw new Error("stopped"); receipts.set(id, "consumed"); if (reject) throw new Error("lost reply"); }),
    stop: vi.fn(async () => { status = "paused"; for (const [id, state] of receipts) if (state === "pending") receipts.set(id, "interrupted"); }),
  };
  const queue = new InputQueue(path, driver); stores.push(queue);
  return { queue, driver, receipts, setStatus(value: NativeState) { status = value; }, lostReply() { reject = true; } };
}
describe("server-owned remote outbox", () => {
  it("waits through running tools and approvals, then merges all queued messages in order", async () => {
    const f = fixture();
    await f.queue.send("a", randomUUID(), "first", [], "queue"); await f.queue.send("a", randomUUID(), "second", [], "queue");
    await f.queue.tick(); f.setStatus("waiting"); await f.queue.tick(); expect(f.driver.send).not.toHaveBeenCalled();
    f.setStatus("completed"); await f.queue.tick();
    expect(f.driver.send).toHaveBeenCalledExactlyOnceWith("a", "first\n\nsecond", expect.any(String), false, expect.any(Function));
    expect(f.queue.state("a").items).toEqual([]);
  });
  it("uses native Steer immediately and leaves its queued peers alone", async () => {
    const f = fixture(), queued = randomUUID(), steered = randomUUID();
    await f.queue.send("a", queued, "later", [], "queue"); await f.queue.send("a", steered, "now", [], "steer");
    expect(f.driver.send).toHaveBeenCalledWith("a", "now", expect.any(String), true, expect.any(Function));
    expect(f.queue.state("a").items.map(row => row.id)).toEqual([queued]);
    await f.queue.action("a", queued, "steer"); expect(f.queue.state("a").items).toEqual([]);
  });
  it("defaults each task to Queue and persists mode independently", () => {
    const f = fixture(); expect(f.queue.state("a").mode).toBe("queue");
    f.queue.mode("a", "steer"); expect(f.queue.state("a").mode).toBe("steer"); expect(f.queue.state("b").mode).toBe("queue");
  });
  it("locks the default mode while pending and allows deleting only an unsent message", async () => {
    const f = fixture(), id = randomUUID(); await f.queue.send("a", id, "later", [], "queue");
    expect(() => f.queue.mode("a", "steer")).toThrow("先处理");
    await f.queue.action("a", id, "remove"); expect(f.queue.state("a").items).toEqual([]);
    await f.queue.send("a", id, "later", [], "queue"); expect(f.queue.state("a").items).toEqual([]);
    await expect(f.queue.action("a", id, "steer")).rejects.toThrow("已提交或已删除");
  });
  it.each(["error", "paused"] as const)("holds pending messages after native %s until Continue", async status => {
    const f = fixture(); await f.queue.send("a", randomUUID(), "retained", [], "queue");
    f.setStatus(status); await f.queue.tick(); f.setStatus("completed"); await f.queue.tick();
    expect(f.driver.send).not.toHaveBeenCalled(); expect(f.queue.state("a").paused).toBe(true);
    await f.queue.control("a", "resume"); expect(f.driver.send).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.driver.send).mock.calls[0][1]).toContain("retained");
  });
  it("Stop holds the queue, even after the original run becomes idle", async () => {
    const f = fixture(); await f.queue.send("a", randomUUID(), "retained", [], "queue"); await f.queue.control("a", "stop");
    f.setStatus("idle"); await f.queue.tick(); expect(f.driver.send).not.toHaveBeenCalled();
    await f.queue.control("a", "resume"); expect(f.queue.state("a").items).toEqual([]);
  });
  it.each(["error", "paused"] as const)("a fresh explicit message starts after %s when no older input is held", async status => {
    const f = fixture(); f.setStatus(status); await f.queue.control("a", "stop"); f.setStatus(status);
    const result = await f.queue.send("a", randomUUID(), "new requirement", [], "queue");
    expect(f.driver.send).toHaveBeenCalledExactlyOnceWith("a", "new requirement", expect.any(String), false, expect.any(Function));
    expect(result).toMatchObject({ paused: false, items: [] });
  });
  it("preserves accepted inputs if state lookup fails instead of asking the client to duplicate them", async () => {
    const f = fixture(), id = randomUUID(); vi.mocked(f.driver.state).mockRejectedValue(new Error("offline"));
    const state = await f.queue.send("a", id, "retained", [], "queue"); expect(state.paused).toBe(true); expect(state.items[0].error).toContain("已保留");
    await f.queue.send("a", id, "retained", [], "queue"); expect(f.queue.state("a").items).toHaveLength(1);
    await expect(f.queue.send("a", id, "different", [], "queue")).rejects.toThrow("其他内容");
  });
  it("uses a native receipt after a lost acknowledgement and never sends a second copy", async () => {
    const f = fixture(), id = randomUUID(); f.setStatus("idle"); f.lostReply();
    await f.queue.send("a", id, "once", [], "queue"); await f.queue.send("a", id, "once", [], "queue");
    await f.queue.tick(); expect(f.queue.state("a").items).toEqual([]); expect(f.driver.send).toHaveBeenCalledTimes(1);
  });
  it("keeps both messages while two native Steers await consumption", async () => {
    const f = fixture(); vi.mocked(f.driver.send).mockImplementation(async (_task, _body, id) => { f.receipts.set(id, "pending"); });
    await f.queue.send("a", randomUUID(), "one", [], "steer"); await f.queue.send("a", randomUUID(), "two", [], "steer");
    expect(f.driver.send).toHaveBeenCalledTimes(2); expect(f.queue.state("a").items).toHaveLength(2);
    for (const id of f.receipts.keys()) f.receipts.set(id, "consumed"); await f.queue.tick(); expect(f.queue.state("a").items).toEqual([]);
  });
  it("restores an unconsumed native Steer when Stop interrupts it", async () => {
    const f = fixture(); vi.mocked(f.driver.send).mockImplementation(async (_task, _body, id) => { f.receipts.set(id, "pending"); });
    const id = randomUUID(); await f.queue.send("a", id, "keep", [], "steer"); await f.queue.control("a", "stop");
    expect(f.queue.state("a")).toMatchObject({ paused: true, items: [{ id, state: "queued" }] });
  });
  it("cancels a delayed admission before Stop and allows deletion after its lock drains", async () => {
    const f = fixture(); f.setStatus("idle");
    let release!: () => void;
    vi.mocked(f.driver.send).mockImplementation(async (_task, _body, _id, _steer, current) => {
      await new Promise<void>(resolve => { release = resolve; }); if (!current()) throw new Error("stopped");
      throw new Error("should not admit");
    });
    const sending = f.queue.send("a", randomUUID(), "later", [], "queue");
    await vi.waitFor(() => expect(release).toBeDefined()); const clearing = f.queue.clear("a"); release(); await sending; await clearing;
    await f.queue.tick(); expect(() => f.queue.state("a")).toThrow("任务已删除");
    await expect(f.queue.send("a", randomUUID(), "late send", [], "queue")).rejects.toThrow("任务已删除");
    expect(f.queue.state("new")).toMatchObject({ mode: "queue", paused: false, items: [] });
  });
  it("retains pending inputs and mode on server restart, but requires explicit recovery", async () => {
    const base = resolve(".work/remote-agent"); mkdirSync(base, { recursive: true });
    const folder = mkdtempSync(resolve(base, "queue-test-")); folders.push(folder); const path = resolve(folder, "inputs.sqlite");
    const f = fixture(path); f.queue.mode("a", "steer"); await f.queue.send("a", randomUUID(), "persistent", [], "queue");
    await f.queue.close(); stores.splice(stores.indexOf(f.queue), 1);
    const reopened = fixture(path); reopened.setStatus("completed"); await reopened.queue.tick();
    expect(reopened.queue.state("a")).toMatchObject({ mode: "steer", paused: true, items: [{ text: "persistent" }] });
    expect(reopened.driver.send).not.toHaveBeenCalled(); await reopened.queue.control("a", "resume"); expect(reopened.queue.state("a").items).toEqual([]);
  });
  it("enforces queue bounds without losing existing messages", async () => {
    const f = fixture(); for (let i = 0; i < 20; i++) await f.queue.send("a", randomUUID(), String(i), [], "queue");
    await expect(f.queue.send("a", randomUUID(), "overflow", [], "queue")).rejects.toThrow("20 条"); expect(f.queue.state("a").items).toHaveLength(20);
  });
});
describe("remote queue contract", () => {
  it("rejects invalid options and malformed state", () => {
    expect(() => remoteSendOptions({ mode: "interrupt", requestId: randomUUID() })).toThrow();
    expect(() => remoteInputQueue({ mode: "queue", paused: false, revision: -1, items: [] })).toThrow();
  });
  it("ignores a stale polling response", () => {
    const previous = { mode: "queue" as const, paused: false, revision: 3, items: [] };
    expect(mergeRemoteInputQueue(previous, { ...previous, revision: 2, mode: "steer" })).toBe(previous);
  });
});
