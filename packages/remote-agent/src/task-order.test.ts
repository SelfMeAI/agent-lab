import { describe, expect, it } from "vitest";
import type { RemoteTask } from "../../contracts/src/remote-agent";
import { mergeRemoteTaskCatalog, sortRemoteTasks, upsertRemoteTask } from "./task-order";

const task = (id: string, updatedAt: string): RemoteTask => ({ id, title: id, status: "completed", createdAt: "2026-10-12T12:00:00.000Z", updatedAt });
const at = (time: string) => `2026-10-12T${time}.000Z`;

describe("remote activity ordering", () => {
  it("does not move an idle task when an older history row is replayed", () => {
    const before = [task("A", at("15:10:00")), task("B", at("15:05:00")), task("C", at("15:00:00"))];
    const replay = upsertRemoteTask(before, { ...task("A", at("14:50:00")), title: "native title" });
    expect(replay.map(task => task.id)).toEqual(["A", "B", "C"]);
    expect(replay[0].title).toBe("native title");
    expect(mergeRemoteTaskCatalog(replay, before).map(task => task.id)).toEqual(["A", "B", "C"]);
  });
  it("moves a task only for newer activity, retaining it through lagging native metadata", () => {
    const before = [task("A", at("15:10:00")), task("B", at("15:05:00"))];
    const live = upsertRemoteTask(before, { ...task("B", at("15:11:00")), status: "running" });
    expect(live.map(task => task.id)).toEqual(["B", "A"]);
    const polled = mergeRemoteTaskCatalog(live, [{ ...before[1], status: "completed" }, before[0]]);
    expect(polled.map(task => task.id)).toEqual(["B", "A"]);
    expect(polled[0].status).toBe("completed");
    expect(polled[0].updatedAt).toBe(at("15:11:00"));
  });
  it("uses a deterministic tie-breaker, does not mutate inputs and honors deletion", () => {
    const before = [task("C", at("15:00:00")), task("A", at("15:00:00")), task("B", at("15:00:00"))];
    expect(sortRemoteTasks(before).map(task => task.id)).toEqual(["A", "B", "C"]);
    expect(before.map(task => task.id)).toEqual(["C", "A", "B"]);
    expect(mergeRemoteTaskCatalog(before, [before[2], before[1]]).map(task => task.id)).toEqual(["A", "B"]);
  });
});
