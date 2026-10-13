import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applicationIdentity, applicationName, legacyApplicationName, legacyApplicationRoot, legacyOwnerLabel, ownerLabel, ownedResource } from "./application-identity";
import { RemoteAgentContainer } from "./remote-agent/service-manager";

let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });
const fixture = () => root = mkdtempSync(join(tmpdir(), "agent-lab-identity-"));

describe("application rename compatibility", () => {
  it("uses the complete current project name for a fresh installation", () => {
    const base = fixture();
    expect(applicationIdentity(base)).toEqual({ root: join(base, applicationName), encryptionName: "Agent Lab" });
  });
  it("adopts the original root and encryption identity without copying or resetting data", () => {
    const base = fixture(); const legacy = join(base, legacyApplicationName); mkdirSync(legacy);
    writeFileSync(join(legacy, "dsh-provider.json"), "retained encrypted settings");
    expect(applicationIdentity(base)).toEqual({ root: legacy, encryptionName: legacyApplicationName });
    expect(legacyApplicationRoot(legacy)).toBe(true);
    const service = new RemoteAgentContainer(legacy, async () => { throw new Error("must not regenerate credentials"); }, "openclaw");
    expect(service.name).toBe(`selfme-lab-openclaw-${service.owner}`);
    expect(service.volume).toBe(`${service.name}-data`);
  });
  it("never combines two existing profiles", () => {
    const base = fixture(); mkdirSync(join(base, legacyApplicationName)); mkdirSync(join(base, applicationName));
    expect(applicationIdentity(base).root).toBe(join(base, applicationName));
  });
  it("refuses symlinked or non-directory application profiles", () => {
    const base = fixture(); mkdirSync(join(base, "other"));
    symlinkSync("other", join(base, legacyApplicationName));
    expect(() => applicationIdentity(base)).toThrow("真实目录");
    writeFileSync(join(base, applicationName), "not a directory");
    expect(() => applicationIdentity(base)).toThrow("真实目录");
  });
  it("accepts owned legacy labels but rejects conflicting and foreign owners", () => {
    expect(ownedResource({ [legacyOwnerLabel]: "owner" }, "owner")).toBe(true);
    expect(ownedResource({ [ownerLabel]: "owner" }, "owner")).toBe(true);
    expect(ownedResource({ [ownerLabel]: "owner", [legacyOwnerLabel]: "other" }, "owner")).toBe(false);
    expect(ownedResource({ [legacyOwnerLabel]: "other" }, "owner")).toBe(false);
    expect(ownedResource(null, "owner")).toBe(false);
  });
});
