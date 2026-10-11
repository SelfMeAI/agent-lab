import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RemoteServiceCredentials } from "./credentials";
import { RemoteAgentContainer } from "./service-manager";
import { RemoteTaskController } from "./task-controller";
import { remoteTaskId } from "../../../../../packages/remote-agent/src/transport/http";
import type { RemoteTaskSnapshot } from "../../../../../packages/contracts/src/remote-agent";

describe.skipIf(process.env.SELFME_REMOTE_INTEGRATION !== "1")("native OpenClaw in-flight takeover", () => {
  it("waits at a real tool boundary, resumes the same round and force-aborts without resubmission", async () => {
    const root = resolve(".work/remote-agent", "takeover-integration-" + randomUUID());
    const keys = new RemoteServiceCredentials(root, { encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() }, "openclaw");
    const container = new RemoteAgentContainer(root, () => keys.get(), "openclaw");
    const connection = { endpoint: () => container.requireEndpoint(), credentials: () => keys.get() };
    const updates: RemoteTaskSnapshot[] = [];
    const tasks = new RemoteTaskController({ openhands: connection, openclaw: connection }, { choose: async () => [], save: async () => null }, update => updates.push(update.snapshot), () => {});
    const claw = tasks.claw, exec = promisify(execFile);
    try {
      await container.start();
      const config = await claw.request<{ hash: string }>("config.get");
      // Test-only loopback provider opt-in in an isolated volume, not the
      // user's provider, browser SSRF policy, proxy or system settings.
      await claw.request("config.patch", { baseHash: config.hash, raw: JSON.stringify({ models: { providers: { selfme: { baseUrl: "http://127.0.0.1:8944/v1", api: "openai-completions", apiKey: "takeover-fixture", request: { allowPrivateNetwork: true }, models: [{ id: "takeover-fixture", name: "Takeover fixture", input: ["text"] }] } } }, agents: { defaults: { model: { primary: "selfme/takeover-fixture" } } }, tools: { codeMode: false } }) });
      await expect.poll(async () => (await container.state()).phase, { timeout: 30_000 }).toBe("ready");
      tasks.reset();
      await exec("docker", ["exec", "--detach", container.name, "node", "--input-type=module", "-e", await readFile("scripts/remote-agent/fixtures/takeover-provider.mjs", "utf8")]);
      await expect.poll(async () => (await exec("docker", ["exec", container.name, "node", "-e", "fetch('http://127.0.0.1:8944/health').then(r=>r.text()).then(console.log)"])).stdout.trim(), { timeout: 5000 }).toBe("ready");
      const soft = await claw.create(); await claw.open(soft.id);
      // Bounded fixture commands only; no alteration of actual user's policy.
      await claw.request("sessions.patch", { key: soft.id, permissionMode: "full" });
      await claw.send(soft.id, "fixture:soft");
      const entries = (id: string) => claw.http.listFiles(id).then(result => result.files.map(file => file.name));
      await expect.poll(() => entries(soft.id), { timeout: 30_000 }).toContain("current-started.txt");
      expect(await claw.sceneAccess(soft.id)).toMatchObject({ agentBusy: true, terminalBusy: true, terminalInputAllowed: false, browserInputAllowed: true });
      expect((await claw.desktop(soft.id, true)).scene?.takeover).toBe("waiting");
      await expect.poll(async () => (await claw.sceneAccess(soft.id)).takeover, { timeout: 15_000 }).toBe("ready");
      expect(await entries(soft.id)).toContain("current-finished.txt");
      expect(await entries(soft.id)).not.toContain("next-finished.txt");
      // Outlast the upstream 15-second default hook timeout on a REAL call.
      await new Promise(resolve => setTimeout(resolve, 17_000));
      expect(await claw.sceneAccess(soft.id)).toMatchObject({ agentBusy: true, takeover: "ready", humanControl: true });
      expect(await entries(soft.id)).not.toContain("next-finished.txt");
      await claw.release();
      await expect.poll(() => entries(soft.id), { timeout: 15_000 }).toContain("next-finished.txt");
      await expect.poll(() => [...updates].reverse().find(update => update.task.id === soft.id)?.task.status, { timeout: 15_000 }).toBe("completed");
      expect(await (await claw.http.download(soft.id, "next-finished.txt")).text()).toBe("NEXT_DONE");
      const history = await claw.request<{ messages: unknown[] }>("chat.history", { sessionKey: soft.id });
      expect(history.messages.filter(row => (row as { role?: string; message?: { role?: string } }).role === "user" || (row as { message?: { role?: string } }).message?.role === "user")).toHaveLength(1);

      const forced = await claw.create(); await claw.open(forced.id);
      await claw.request("sessions.patch", { key: forced.id, permissionMode: "full" });
      await claw.send(forced.id, "fixture:force");
      await expect.poll(() => entries(forced.id), { timeout: 30_000 }).toContain("current-started.txt");
      await claw.desktop(forced.id, true); await claw.desktop(forced.id, true, true);
      await expect.poll(async () => (await claw.sceneAccess(forced.id)).takeover, { timeout: 15_000 }).toBe("ready");
      expect(await claw.sceneAccess(forced.id)).toMatchObject({ agentBusy: false, terminalBusy: false });
      expect(await entries(forced.id)).not.toContain("current-finished.txt");
      await claw.release();
      expect(await entries(forced.id)).not.toContain("next-finished.txt");
      expect((await claw.sceneAccess(forced.id)).takeover).toBe("none");
      expect(remoteTaskId(forced.id)).toMatch(/^[a-f0-9-]+$/);
    } catch (error) {
      console.error((await container.logs()).slice(-7000)); throw error;
    } finally {
      tasks.shutdown(); await container.stop();
      await exec("docker", ["rm", container.name]); await exec("docker", ["volume", "rm", container.volume]);
      await rm(root, { recursive: true, force: true });
    }
  }, 150_000);
});
