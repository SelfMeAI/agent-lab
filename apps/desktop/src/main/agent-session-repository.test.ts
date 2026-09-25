import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../../../../packages/contracts/src/index";
import { AgentSessionRepository } from "./agent-session-repository";
import { AppConfigStore } from "./app-config";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function event(kind: RunEvent["kind"], text: string, phase?: RunEvent["phase"]): RunEvent {
  return { runtimeId: "pi", runId: "run-1", sequence: 1, at: new Date().toISOString(), source: "Pi", kind, text, phase };
}

describe("agent session SQLite storage", () => {
  it("keeps sessions, native references, and independent event streams across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-sessions-"));
    roots.push(root);
    const first = new AgentSessionRepository(root);
    await first.init();
    const a = first.create("pi", root);
    const b = first.create("pi", root);
    first.setNativeRef(a.id, join(root, "pi-session.jsonl"));
    first.append(a.id, event("user", "请检查这个项目"));
    first.append(a.id, event("status", "正在执行", "running"));
    first.append(a.id, event("message", "已检查"));
    first.append(b.id, event("user", "另一个实验"));
    first.close();

    const reopened = new AgentSessionRepository(root);
    await reopened.init();
    expect(reopened.get(a.id)).toMatchObject({ nativeRef: join(root, "pi-session.jsonl"), title: "请检查这个项目", phase: "idle" });
    expect(reopened.get(a.id).statusText).toContain("中断");
    expect(reopened.events(a.id).map((entry) => entry.kind)).toEqual(["user", "status", "message"]);
    expect(reopened.events(b.id).map((entry) => entry.text)).toEqual(["另一个实验"]);
    expect(reopened.list("pi").map((entry) => entry.id)).toEqual([b.id, a.id]);
    reopened.close();
  });

  it("stores UI selection in a separate config file", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-config-"));
    roots.push(root);
    const first = new AppConfigStore(root);
    await first.init();
    await first.select("dsh", "session-a", root);
    const reopened = new AppConfigStore(root);
    await reopened.init();
    expect(reopened.get("dsh")).toEqual({ selectedSessionId: "session-a", lastWorkspace: root });
    expect(reopened.get("pi")).toEqual({ selectedSessionId: null, lastWorkspace: null });
  });

  it("keeps the last selection when config writes overlap", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfme-config-overlap-"));
    roots.push(root);
    const config = new AppConfigStore(root);
    await config.init();
    await Promise.all([
      config.select("dsh", "first", root),
      config.select("pi", "second", root),
      config.select("dsh", "third", root),
    ]);
    const reopened = new AppConfigStore(root);
    await reopened.init();
    expect(reopened.get("dsh").selectedSessionId).toBe("third");
    expect(reopened.get("pi").selectedSessionId).toBe("second");
  });

});
