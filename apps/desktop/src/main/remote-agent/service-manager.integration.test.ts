import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RemoteServiceCredentials } from "./credentials";
import { RemoteAgentContainer } from "./service-manager";
import { RemoteModelClient } from "../../../../../packages/remote-agent/src/model-connection";

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
      } finally {
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
