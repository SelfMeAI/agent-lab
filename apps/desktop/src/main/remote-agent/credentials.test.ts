import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { RemoteServiceCredentials, type CredentialEncryption } from "./credentials";

const encryption: CredentialEncryption = {
  encrypt: async (value) => Buffer.from(Buffer.from(value).map(byte => byte ^ 127)),
  decrypt: async (value) => value.map(byte => byte ^ 127).toString(),
};
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> {
  const work = fileURLToPath(new URL("../../../../../../.work/", import.meta.url));
  await mkdir(work, { recursive: true });
  const path = await mkdtemp(join(work, "remote-auth-test-")); roots.push(path); return path;
}

describe("remote development pairing", () => {
  it("creates independent random API and persistence keys without plaintext on disk", async () => {
    const path = await root();
    const credentials = await new RemoteServiceCredentials(path, encryption).get();
    expect(credentials.sessionApiKey).toMatch(/^[a-f0-9]{64}$/);
    expect(credentials.persistenceKey).toMatch(/^[\w-]{43}=$/);
    const stored = await readFile(join(path, "openhands-service-credentials.json"), "utf8");
    expect(stored).not.toContain(credentials.sessionApiKey);
    expect(stored).not.toContain(credentials.persistenceKey);
    expect(await new RemoteServiceCredentials(path, encryption).get()).toEqual(credentials);
  });
  it("coalesces first connection requests and never rotates keys on malformed storage", async () => {
    const path = await root();
    const store = new RemoteServiceCredentials(path, encryption);
    const [a, b] = await Promise.all([store.get(), store.get()]);
    expect(a).toEqual(b);
    await writeFile(join(path, "openhands-service-credentials.json"), "broken");
    await expect(new RemoteServiceCredentials(path, encryption).get()).rejects.toThrow();
    expect(await readFile(join(path, "openhands-service-credentials.json"), "utf8")).toBe("broken");
  });

  it("keeps engine pairing independent", async () => {
    const path = await root();
    const openhands = await new RemoteServiceCredentials(path, encryption, "openhands").get();
    const openclaw = await new RemoteServiceCredentials(path, encryption, "openclaw").get();
    expect(openclaw.sessionApiKey).not.toBe(openhands.sessionApiKey);
    expect(openclaw.device?.deviceId).toMatch(/^[a-f0-9]{64}$/);
    const stored = await readFile(join(path, "openclaw-service-credentials.json"), "utf8");
    expect(stored).not.toContain("PRIVATE KEY");
    expect(await new RemoteServiceCredentials(path, encryption, "openclaw").get()).toEqual(openclaw);
  });
  it("does not replace a corrupted OpenClaw device key or rotate its server secrets", async () => {
    const path = await root();
    const original = await new RemoteServiceCredentials(path, encryption, "openclaw").get();
    const corrupted = { ...original, device: { ...original.device!, deviceId: "broken" } };
    const stored = JSON.stringify({ version: 1, encrypted: (await encryption.encrypt(JSON.stringify(corrupted))).toString("base64") });
    await writeFile(join(path, "openclaw-service-credentials.json"), stored);
    await expect(new RemoteServiceCredentials(path, encryption, "openclaw").get()).rejects.toThrow("设备身份损坏");
    expect(await readFile(join(path, "openclaw-service-credentials.json"), "utf8")).toBe(stored);
  });
});
