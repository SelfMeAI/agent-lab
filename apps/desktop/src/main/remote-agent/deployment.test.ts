import { describe, expect, it } from "vitest";
import { openClawBootstrap, redactServiceOutput, remoteDeployments } from "./deployment";

describe("private remote development deployment", () => {
  it("uses pinned native images, encrypted OH persistence and a private OC home", () => {
    expect(remoteDeployments.openhands.image).toContain("source-54daf056bd86");
    expect(remoteDeployments.openclaw.image).toContain("source-bcfc88812a35");
    expect(remoteDeployments.openclaw.mount).toBe("/home/node/.openclaw");
    expect(openClawBootstrap).toContain("flag: 'wx'");
    expect(openClawBootstrap).toContain("${OPENCLAW_GATEWAY_TOKEN}");
    expect(openClawBootstrap).not.toContain("dangerouslyDisableDeviceAuth");
    expect(openClawBootstrap).toContain("'localhost', '127.0.0.1'");
    expect(openClawBootstrap).not.toContain("dangerouslyAllowPrivateNetwork");
    expect(openClawBootstrap).toContain("security: 'allowlist', ask: 'on-miss'");
  });
  it("redacts development auth, provider keys and credential-shaped log fields", () => {
    expect(redactServiceOutput("credential-one sk-example-provider123 token=secret api_key: 'hidden' normal log", ["credential-one"]))
      .toBe("[已隐藏] [已隐藏] token=[已隐藏] api_key: [已隐藏] normal log");
  });
  it("keeps the previous desktop deployment eligible for a volume-preserving upgrade", () => {
    expect(remoteDeployments.openclaw.image).toBe("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab18");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab15");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab14");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab13");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab12");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab11");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab10");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab9");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab8");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab7");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab5");
    expect(openClawBootstrap).toContain("await configureDesktop()");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab4");
    expect(remoteDeployments.openclaw.legacyImages).toContain("selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab3");
    expect(openClawBootstrap.indexOf("recoverManagedBrowserProfile(home")).toBeLessThan(openClawBootstrap.indexOf("const child = spawn"));
    expect(openClawBootstrap).toContain("SELFME_OPENCLAW_PRIVATE_VOLUME");
  });
});
