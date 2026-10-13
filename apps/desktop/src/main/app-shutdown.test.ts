import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRepository } from "./agent-session-repository";
import { installAppShutdown } from "./app-shutdown";

class FakeApp extends EventEmitter {
  quit = vi.fn(() => { this.emit("before-quit", { preventDefault: vi.fn() }); });
  requestQuit(): ReturnType<typeof vi.fn> {
    const preventDefault = vi.fn();
    this.emit("before-quit", { preventDefault });
    return preventDefault;
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("app shutdown storage lifetime", () => {
  it("resumes Quit on a later event-loop turn even if cleanup resolves immediately", async () => {
    const deferred: Array<() => void> = [];
    const schedule = vi.spyOn(globalThis, "setImmediate").mockImplementation((callback) => {
      deferred.push(() => callback());
      return {} as NodeJS.Immediate;
    });
    try {
      const app = new FakeApp();
      const stopSessions = vi.fn(async () => {});
      installAppShutdown(app, stopSessions, vi.fn(), vi.fn());
      app.requestQuit();
      await vi.waitFor(() => expect(deferred).toHaveLength(1));
      expect(stopSessions).toHaveBeenCalledOnce();
      expect(app.quit).not.toHaveBeenCalled();
      deferred[0]();
      expect(app.quit).toHaveBeenCalledOnce();
    } finally { schedule.mockRestore(); }
  });

  it("keeps the real session catalog readable until windows close, then preserves it on restart", async () => {
    const work = join(process.cwd(), ".work");
    await mkdir(work, { recursive: true });
    const root = await mkdtemp(join(work, "shutdown-storage-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const repository = new AgentSessionRepository(root);
    cleanups.push(async () => repository.close());
    await repository.init();
    const session = repository.create("qwen-code", root);
    repository.append(session.id, { runtimeId: "qwen-code", runId: "test", sequence: 1,
      at: new Date().toISOString(), source: "test", kind: "user", text: "保留这段对话" });
    const app = new FakeApp();
    let finish!: () => void;
    const stopSessions = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const closeDatabase = vi.fn(() => repository.close());
    const shutdown = installAppShutdown(app, stopSessions, closeDatabase, vi.fn());

    expect(app.requestQuit()).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(stopSessions).toHaveBeenCalledOnce());
    expect(shutdown.isQuitting()).toBe(true);
    // The still-open window may request agent-lab:agent-session-catalog at either
    // point. Before-quit must never put the repository into the closed state.
    expect(repository.list("qwen-code")[0].id).toBe(session.id);
    finish();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(closeDatabase).not.toHaveBeenCalled();
    expect(repository.list("qwen-code")[0].id).toBe(session.id);
    expect(repository.events(session.id)[0].text).toBe("保留这段对话");

    app.emit("will-quit", { preventDefault: vi.fn() });
    expect(closeDatabase).toHaveBeenCalledOnce();
    const reopened = new AgentSessionRepository(root);
    cleanups.push(async () => reopened.close());
    await reopened.init();
    expect(reopened.list("qwen-code")[0].id).toBe(session.id);
    expect(reopened.events(session.id)[0].text).toBe("保留这段对话");
  });

  it("shares one cleanup across repeated Quit requests", async () => {
    const app = new FakeApp();
    let finish!: () => void;
    const stopSessions = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const closeDatabase = vi.fn();
    installAppShutdown(app, stopSessions, closeDatabase, vi.fn());
    for (let i = 0; i < 3; i++) expect(app.requestQuit()).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(stopSessions).toHaveBeenCalledOnce());
    finish();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(stopSessions).toHaveBeenCalledOnce();
    expect(closeDatabase).not.toHaveBeenCalled();
    // The internally resumed Quit is no longer prevented.
    expect(app.requestQuit()).not.toHaveBeenCalled();
    app.emit("will-quit", { preventDefault: vi.fn() });
    app.emit("will-quit", { preventDefault: vi.fn() });
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("reports cleanup failure without closing storage under an open window", async () => {
    const app = new FakeApp();
    const failure = new Error("child process stop failed");
    const reportError = vi.fn();
    const closeDatabase = vi.fn();
    installAppShutdown(app, async () => { throw failure; }, closeDatabase, reportError);
    app.requestQuit();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(reportError).toHaveBeenCalledWith(failure);
    expect(closeDatabase).not.toHaveBeenCalled();
    app.emit("will-quit", { preventDefault: vi.fn() });
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("does not shut down storage when macOS only closes the last window", () => {
    const app = new FakeApp();
    const stopSessions = vi.fn(async () => {});
    const closeDatabase = vi.fn();
    const shutdown = installAppShutdown(app, stopSessions, closeDatabase, vi.fn());
    app.emit("window-all-closed");
    expect(shutdown.isQuitting()).toBe(false);
    expect(stopSessions).not.toHaveBeenCalled();
    expect(closeDatabase).not.toHaveBeenCalled();
  });
});
