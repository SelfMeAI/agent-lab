import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RemoteServiceCredentials } from "./credentials";
import { RemoteAgentContainer } from "./service-manager";
import { RemoteTaskController } from "./task-controller";
import { RemoteModelClient } from "../../../../../packages/remote-agent/src/model-connection";
import type { RemoteTaskSnapshot } from "../../../../../packages/contracts/src/remote-agent";

const exec = promisify(execFile);
type Proof = Record<string, { waiting: boolean; calls: Array<{ steer: boolean; first: boolean; second: boolean }> }>;
describe.skipIf(process.env.AGENT_LAB_REMOTE_INPUT_INTEGRATION !== "1")("native remote mid-turn inputs", () => {
  for (const engine of ["openclaw", "openhands"] as const) it(`${engine}: real Steer, whole-turn Queue, retained Stop and closed-client delivery`, async () => {
    const root = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)), ".work/remote-agent", "input-integration-" + engine + "-" + randomUUID());
    const credentials = new RemoteServiceCredentials(root, { encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() }, engine);
    const container = new RemoteAgentContainer(root, () => credentials.get(), engine);
    const connection = { endpoint: () => container.requireEndpoint(), credentials: () => credentials.get() };
    const updates = new Map<string, RemoteTaskSnapshot>();
    const controller = new RemoteTaskController({ openclaw: connection, openhands: connection }, { choose: async () => [], save: async () => null }, event => updates.set(event.taskId, event.snapshot), () => {});
    const client = controller.client(engine);
    try {
      expect((await container.start()).phase).toBe("ready");
      await exec("docker", ["exec", "--detach", container.name, "node", "--input-type=module", "-e", await readFile(new URL("../../../../../scripts/remote-agent/fixtures/input-provider.mjs", import.meta.url), "utf8")]);
      const models = new RemoteModelClient(engine, connection.endpoint, connection.credentials);
      await models.save({ protocol: "openai", baseUrl: "http://127.0.0.1:8945/v1", apiKey: "inputs-fixture", model: "inputs-fixture" });
      await ready();
      if (engine === "openclaw") {
        const cfg = await controller.claw.request<{ hash: string }>("config.get");
        await controller.claw.request("config.patch", { baseHash: cfg.hash, raw: JSON.stringify({ models: { providers: { agent_lab: { request: { allowPrivateNetwork: true } } } }, tools: { codeMode: false } }) }); await ready();
      }
      const task = await client.create(); await client.open(task.id);
      expect(await client.inputQueue(task.id)).toMatchObject({ mode: "queue", items: [] });
      const scenario = "INPUTS_QUEUE_" + randomUUID();
      await client.send(task.id, scenario); await waiting(scenario);
      const first = randomUUID(), second = randomUUID();
      await client.send(task.id, "AFTER_TURN_ONE", [], { mode: "queue", requestId: first });
      await client.send(task.id, "AFTER_TURN_TWO", [], { mode: "queue", requestId: second });
      expect((await client.inputQueue(task.id)).items.map(row => row.id)).toEqual([first, second]);
      await expect(client.inputMode(task.id, "steer")).rejects.toThrow("先处理");
      const steer = randomUUID();
      await client.send(task.id, "MID_TURN_STEER", [], { mode: "steer", requestId: steer });
      await release(scenario);
      if (engine === "openhands") {
        await expect.poll(() => updates.get(task.id)?.items.find(item => item.approval)?.approval?.id, { timeout: 30_000 }).toBeTruthy();
        const approval = updates.get(task.id)!.items.find(item => item.approval)!.approval!;
        await client.approve(task.id, approval.id, "once");
      }
      await expect.poll(async () => (await proof())[scenario]?.calls.length, { timeout: 35_000 }).toBeGreaterThanOrEqual(3);
      const calls = (await proof())[scenario].calls;
      expect(calls[1]).toMatchObject({ steer: true, first: false, second: false });
      expect(calls[2]).toMatchObject({ first: true, second: true });
      await expect.poll(async () => (await client.inputQueue(task.id)).items.length, { timeout: 10_000 }).toBe(0);
      await client.send(task.id, "AFTER_TURN_ONE", [], { mode: "queue", requestId: first });
      await client.send(task.id, "MID_TURN_STEER", [], { mode: "steer", requestId: steer });
      expect((await proof())[scenario].calls).toHaveLength(3);
      await client.inputMode(task.id, "steer"); await client.close(task.id); await client.open(task.id);
      expect((await client.inputQueue(task.id)).mode).toBe("steer");
      const isolated = await client.create(); await client.open(isolated.id); expect((await client.inputQueue(isolated.id)).mode).toBe("queue");

      // Wait for genuine native approval. New text must never authorize the tool.
      {
        const guarded = await client.create(); await client.open(guarded.id);
        await client.send(guarded.id, "INPUTS_APPROVAL_" + randomUUID());
        await expect.poll(() => updates.get(guarded.id)?.items.find(item => item.approval)?.approval?.id, { timeout: 30_000 }).toBeTruthy();
        if (engine === "openhands") {
          await client.send(guarded.id, "MID_TURN_STEER", [], { mode: "steer", requestId: randomUUID() });
          await expect.poll(() => updates.get(guarded.id)?.task.status, { timeout: 20_000 }).toBe("completed");
        } else {
          const guard = updates.get(guarded.id)!.items.find(item => item.approval)!.approval!;
          await client.approve(guarded.id, guard.id, "once");
          await expect.poll(() => updates.get(guarded.id)?.task.status, { timeout: 20_000 }).toBe("completed");
        }
        expect((await client.http.listFiles(guarded.id)).files.some(file => file.name === "should-not-exist.txt")).toBe(engine === "openclaw");
        await client.delete(guarded.id);
        if (engine === "openhands") {
          const pausedApproval = await client.create(); await client.open(pausedApproval.id);
          await client.send(pausedApproval.id, "INPUTS_APPROVAL_" + randomUUID());
          await expect.poll(() => updates.get(pausedApproval.id)?.items.some(item => item.approval), { timeout: 25_000 }).toBe(true);
          await client.control(pausedApproval.id, "stop"); await client.control(pausedApproval.id, "resume");
          await expect.poll(() => updates.get(pausedApproval.id)?.task.status, { timeout: 20_000 }).toBe("completed");
          expect((await client.http.listFiles(pausedApproval.id)).files.some(file => file.name === "should-not-exist.txt")).toBe(false);
          await client.delete(pausedApproval.id);
        }
      }

      const stopped = await client.create(); await client.open(stopped.id);
      const stopScenario = "INPUTS_STOP_" + randomUUID(); await client.send(stopped.id, stopScenario); await waiting(stopScenario);
      await client.send(stopped.id, "AFTER_TURN_ONE", [], { mode: "queue", requestId: randomUUID() });
      await client.control(stopped.id, "stop"); await release(stopScenario);
      expect(await client.inputQueue(stopped.id)).toMatchObject({ paused: true, items: [{ text: "AFTER_TURN_ONE" }] });
      controller.reset(); await container.restart();
      await exec("docker", ["exec", "--detach", container.name, "node", "--input-type=module", "-e", await readFile(new URL("../../../../../scripts/remote-agent/fixtures/input-provider.mjs", import.meta.url), "utf8")]);
      await expect.poll(() => client.open(stopped.id), { timeout: 15_000 }).toMatchObject({ connection: "connected" });
      expect(await client.inputQueue(stopped.id)).toMatchObject({ paused: true, items: [{ text: "AFTER_TURN_ONE" }] });
      await client.control(stopped.id, "resume");
      await expect.poll(async () => (await client.inputQueue(stopped.id)).items.length, { timeout: 20_000 }).toBe(0);

      const failed = await client.create(); await client.open(failed.id);
      const errorScenario = "INPUTS_ERROR_" + randomUUID(); await client.send(failed.id, errorScenario); await waiting(errorScenario);
      await client.send(failed.id, "AFTER_TURN_ONE", [], { mode: "queue", requestId: randomUUID() }); await release(errorScenario);
      await expect.poll(() => updates.get(failed.id)?.task.status, { timeout: 30_000 }).toBe("error");
      await expect.poll(() => client.inputQueue(failed.id), { timeout: 10_000 }).toMatchObject({ paused: true, items: [{ text: "AFTER_TURN_ONE" }] });
      expect((await proof())[errorScenario].calls).toHaveLength(1);
      await client.control(failed.id, "resume");
      await expect.poll(async () => (await client.inputQueue(failed.id)).items.length, { timeout: 15_000 }).toBe(0);

      const fresh = await client.create(); await client.open(fresh.id);
      await client.control(fresh.id, "stop"); await client.send(fresh.id, "fresh requirement after Stop");
      await expect.poll(() => updates.get(fresh.id)?.items.some(item => item.role === "assistant" && item.text.includes("FIXTURE_UNKNOWN")), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => updates.get(fresh.id)?.task.status, { timeout: 15_000 }).toBe("completed");
      await expect.poll(() => client.inputQueue(fresh.id), { timeout: 10_000 }).toMatchObject({ paused: false, items: [] });

      const closed = await client.create(); await client.open(closed.id);
      const closeScenario = "INPUTS_CLOSE_" + randomUUID(); await client.send(closed.id, closeScenario); await waiting(closeScenario);
      await client.send(closed.id, "AFTER_TURN_ONE", [], { mode: "queue", requestId: randomUUID() });
      await client.close(closed.id); await release(closeScenario);
      await expect.poll(async () => (await proof())[closeScenario]?.calls.some(call => call.first), { timeout: 25_000 }).toBe(true);
      await client.open(closed.id); await expect.poll(async () => (await client.inputQueue(closed.id)).items, { timeout: 10_000 }).toEqual([]);
      for (const row of [task, isolated, stopped, failed, fresh, closed]) await client.delete(row.id);
    } catch (error) {
      console.error(JSON.stringify({ engine, proof: await proof().catch(() => null), snapshots: [...updates.values()].map(snapshot => ({ status: snapshot.task.status, failure: snapshot.failure, queue: snapshot.queue, tools: snapshot.items.filter(item => item.tool || item.approval).map(item => ({ tool: item.tool, approval: item.approval })) })) }));
      console.error((await container.logs()).slice(-4000));
      throw error;
    } finally {
      controller.shutdown(); await container.stop();
      await exec("docker", ["rm", container.name]); await exec("docker", ["volume", "rm", container.volume]);
      await exec("docker", ["network", "rm", `agent-lab-document-preview-${container.owner}-network`]);
      await rm(root, { recursive: true, force: true });
    }
    async function ready() { await expect.poll(async () => (await container.state()).phase, { timeout: 35_000, interval: 800 }).toBe("ready"); }
    async function proof(): Promise<Proof> { const r = await exec("docker", ["exec", container.name, "node", "--input-type=module", "-e", "process.stdout.write(await (await fetch('http://127.0.0.1:8945/proof')).text())"]); return JSON.parse(r.stdout); }
    async function release(scenario: string) { await exec("docker", ["exec", container.name, "node", "--input-type=module", "-e", "await fetch('http://127.0.0.1:8945/release',{method:'POST',body:JSON.stringify({scenario:process.argv[1]})})", scenario]); }
    async function waiting(scenario: string) { await expect.poll(async () => (await proof())[scenario]?.waiting, { timeout: 40_000, interval: 500 }).toBe(true); }
  }, 240_000);
});
