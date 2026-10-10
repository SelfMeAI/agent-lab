import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RemoteServiceCredentials } from "./credentials";
import { RemoteAgentContainer } from "./service-manager";
import { RemoteModelClient } from "../../../../../packages/remote-agent/src/model-connection";
import { RemoteTaskController } from "./task-controller";
import { remoteTaskId } from "../../../../../packages/remote-agent/src/transport/http";
import type { RemoteTerminalEvent } from "../../../../../packages/contracts/src/remote-agent";

// Explicit Docker integration; fixture-only connection keys, never real API calls.
describe.skipIf(process.env.SELFME_REMOTE_INTEGRATION !== "1")("native source-built remote services", () => {
  for (const engine of ["openhands", "openclaw"] as const) {
    it(`${engine}: authenticated start, native config persistence, restart and retained data`, async () => {
      const root = resolve(".work", "remote-agent", `integration-${engine}-${randomUUID()}`);
      const credentials = new RemoteServiceCredentials(root, {
        encrypt: async value => Buffer.from(value), decrypt: async value => value.toString(),
      }, engine);
      const container = new RemoteAgentContainer(root, () => credentials.get(), engine);
      const models = new RemoteModelClient(engine, () => container.requireEndpoint(), () => credentials.get());
      const connection = { endpoint: () => container.requireEndpoint(), credentials: () => credentials.get() };
      const terminalEvents: RemoteTerminalEvent[] = [];
      const tasks = new RemoteTaskController({ openhands: connection, openclaw: connection }, { choose: async () => [], save: async () => null }, () => {}, event => terminalEvents.push(event));
      try {
        const state = await container.start();
        expect(state.phase).toBe("ready");
        expect(state.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const keys = await credentials.get();
        const saved = await models.save({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: `fixture-${randomUUID()}` });
        expect(saved.configured).toBe(true);
        // OpenClaw may hot-reload config.patch; wait on native readiness, no repeated write.
        await ready();
        expect(await models.get()).toMatchObject({ model: "deepseek-chat", baseUrl: "https://api.deepseek.com", configured: true });
        await models.save({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-reasoner" });
        await ready();
        await container.restart();
        expect(await models.get()).toMatchObject({ model: "deepseek-reasoner", configured: true });
        const client = tasks.client(engine), task = await client.create();
        expect((await client.list()).some(row => row.id === task.id)).toBe(true);
        const files = client.http, body = new TextEncoder().encode("NATIVE_REMOTE_FILES_OK\n");
        expect((await files.upload(task.id, "uploads/proof.txt", body)).size).toBe(body.length);
        expect((await files.listFiles(task.id, "uploads")).files.map(row => row.name)).toEqual(["proof.txt"]);
        expect(await (await files.download(task.id, "uploads/proof.txt")).text()).toBe("NATIVE_REMOTE_FILES_OK\n");
        await expect(files.upload(task.id, "uploads/proof.txt", body)).rejects.toThrow("同名文件");
        const fileRoute = engine === "openhands" ? "/api/selfme/files" : "/selfme-lab/files";
        const query = new URLSearchParams({ task: remoteTaskId(task.id), path: "../private" });
        await expect(files.request(`${fileRoute}?${query}`)).rejects.toThrow("文件路径");
        expect([401, 403]).toContain((await fetch(`${await container.requireEndpoint()}${fileRoute}?task=${remoteTaskId(task.id)}&op=list`)).status);
        if (engine === "openhands") {
          const grant = await tasks.desktop(engine, task.id, false);
          expect(grant.control).toBe(false); expect(await framebufferHeader(grant.url)).toMatch(/^RFB /);
          await expect(framebufferHeader(grant.url)).rejects.toThrow();
        } else {
          const grant = await tasks.desktop(engine, task.id, false);
          expect(await framebufferHeader(grant.url)).toMatch(/^RFB /);
          await defaultDesktopReady(container.name);
          const terminal = await tasks.claw.terminal(task.id);
          expect(terminal.cwd).toBe(`/home/node/.openclaw/workspace/selfme/${remoteTaskId(task.id)}`);
          await tasks.claw.terminalInput(task.id, terminal.id, "printf '\\nREMOTE_PTY_OK\\n'; pwd\r");
          await expect.poll(() => terminalEvents.map(event => event.data ?? "").join(""), { timeout: 15_000 }).toMatch(/\r?\nREMOTE_PTY_OK\r?\n/);
          await tasks.claw.terminalClose(task.id, terminal.id);
          const browser = await tasks.claw.browser(task.id);
          expect(browser.pageUrl).toBe("about:blank"); expect(browser.tabs.some(tab => tab.targetId === browser.targetId)).toBe(true);
          expect(await browserFrameLength(browser.url)).toBeGreaterThan(100);
          await expect(tasks.claw.browser(task.id, { targetId: "unowned" })).rejects.toThrow("不属于");
          const lease = await tasks.claw.request<{ id: string }>("selfme.control.acquire", { task: remoteTaskId(task.id) });
          await expect(tasks.claw.request("selfme.control.acquire", { task: remoteTaskId(task.id) })).rejects.toThrow("已有接管者");
          await tasks.claw.request("selfme.control.release", { id: lease.id });
        }
        tasks.reset(); await container.restart();
        expect((await client.list()).some(row => row.id === task.id)).toBe(true);
        expect(await (await files.download(task.id, "uploads/proof.txt")).text()).toBe("NATIVE_REMOTE_FILES_OK\n");
        if (engine === "openclaw") {
          const grant = await tasks.desktop(engine, task.id, false);
          expect(await framebufferHeader(grant.url)).toMatch(/^RFB /);
          await defaultDesktopReady(container.name);
        }
        await client.delete(task.id); expect((await client.list()).some(row => row.id === task.id)).toBe(false);
        if (engine === "openhands") {
          const denied = await fetch(`${await container.requireEndpoint()}/api/settings`);
          expect([401, 403]).toContain(denied.status);
        }
        const logs = await container.logs();
        expect(logs).not.toContain(keys.sessionApiKey);
        expect(logs).not.toContain(keys.persistenceKey);
        expect((await container.stop()).phase).toBe("stopped");
        expect((await container.start()).phase).toBe("ready");
        expect((await models.get()).model).toBe("deepseek-reasoner");
      } catch (error) {
        console.error((await container.logs()).slice(-5000)); throw error;
      } finally {
        tasks.shutdown();
        // Only this test's unique, ownership-checked fixture is removed.
        await container.stop();
        const exec = promisify(execFile);
        await exec("docker", ["rm", container.name]);
        await exec("docker", ["volume", "rm", container.volume]);
        await rm(root, { recursive: true, force: true });
      }
      async function ready() {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if ((await container.state()).phase === "ready") return;
          await new Promise(resolve => setTimeout(resolve, 800));
        }
        throw new Error(`${engine} 保存设置后未恢复连接`);
      }
    }, 180_000);
  }
});

async function defaultDesktopReady(container: string): Promise<void> {
  const exec = promisify(execFile);
  await expect.poll(async () => {
    try {
      await exec("docker", ["exec", container, "sh", "-lc", "test -x /usr/bin/xfdesktop && test -x /usr/bin/thunar && test -e /usr/share/images/desktop-base/default && pgrep -x xfdesktop >/dev/null"]);
      return true;
    } catch { return false; }
  }, { timeout: 15_000 }).toBe(true);
}

async function framebufferHeader(url: string): Promise<string> {
  const socket = new WebSocket(url, "binary"); socket.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("观察连接超时")), 10_000);
    let settled = false;
    const finish = (error?: Error, header?: string) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(header!); };
    socket.addEventListener("message", event => finish(undefined, new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer))));
    socket.addEventListener("error", () => finish(new Error("观察连接被拒绝")));
    socket.addEventListener("close", event => finish(new Error(`观察连接已关闭（${event.code}）${event.reason}`)));
  });
}

async function browserFrameLength(url: string): Promise<number> {
  const socket = new WebSocket(url); socket.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("浏览器没有传回实际画面")), 20_000); let settled = false;
    const finish = (error?: Error, size?: number) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(size!); };
    socket.addEventListener("message", event => { if (typeof event.data !== "string") finish(undefined, (event.data as ArrayBuffer).byteLength); });
    socket.addEventListener("error", () => finish(new Error("浏览器画面连接失败")));
    socket.addEventListener("close", () => finish(new Error("浏览器画面连接已关闭")));
  });
}
