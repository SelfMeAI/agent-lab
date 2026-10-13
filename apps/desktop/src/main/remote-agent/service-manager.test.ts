import { describe, expect, it } from "vitest";
import { assertExclusiveServiceVolume, containerEndpoint, OPENHANDS_IMAGE } from "./service-manager";
import { remoteDeployments } from "./deployment";

function container() {
  return {
    Config: { Image: OPENHANDS_IMAGE, Labels: { "ai.agent-lab.desktop.owner": "test-owner" } as Record<string, string> },
    State: { Running: true },
    Mounts: [{ Type: "volume", Name: "test-private-volume", Destination: "/workspace" }],
    HostConfig: { Mounts: [] as Array<{ Type: string; Source: string; Target: string; VolumeOptions?: { Subpath?: string; NoCopy?: boolean } }> },
    NetworkSettings: { Ports: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "18000" }] } as Record<string, Array<{ HostIp: string; HostPort: string }>> },
  };
}

describe("development service ownership", () => {
  it("recovers browser locks only with an owned volume not referenced by another container", () => {
    const labels = { "ai.agent-lab.desktop.owner": "owner" };
    expect(() => assertExclusiveServiceVolume(labels, "owner", [], "managed")).not.toThrow();
    expect(() => assertExclusiveServiceVolume(labels, "owner", ["managed"], "managed")).not.toThrow();
    expect(() => assertExclusiveServiceVolume(null, "owner", [], "managed")).toThrow("不属于");
    expect(() => assertExclusiveServiceVolume(labels, "foreign", [], "managed")).toThrow("不属于");
    expect(() => assertExclusiveServiceVolume(labels, "owner", ["managed", "other-stopped-or-running"], "managed")).toThrow("其他容器");
  });
  it("accepts only the matching private source-built service", () => {
    expect(containerEndpoint(container(), "test-owner", "test-private-volume")).toBe("http://127.0.0.1:18000");
    const stopped = container(); stopped.State.Running = false;
    expect(containerEndpoint(stopped, "test-owner", "test-private-volume")).toBeNull();
  });
  it("refuses unrelated containers, host workspaces and public ports", () => {
    const other = container(); other.Config.Labels["ai.agent-lab.desktop.owner"] = "other";
    expect(() => containerEndpoint(other, "test-owner", "test-private-volume")).toThrow();
    const mount = container(); mount.Mounts[0].Type = "bind";
    expect(() => containerEndpoint(mount, "test-owner", "test-private-volume")).toThrow();
    const extra = container(); extra.Mounts.push({ Type: "bind", Name: "host", Destination: "/host" });
    expect(() => containerEndpoint(extra, "test-owner", "test-private-volume")).toThrow();
    const publicPort = container(); publicPort.NetworkSettings.Ports["8000/tcp"][0].HostIp = "0.0.0.0";
    expect(() => containerEndpoint(publicPort, "test-owner", "test-private-volume")).toThrow();
    const badPort = container(); badPort.NetworkSettings.Ports["8000/tcp"][0].HostPort = "NaN";
    expect(() => containerEndpoint(badPort, "test-owner", "test-private-volume")).toThrow();
  });
  it("keeps OpenClaw's native home isolated with its own source and port", () => {
    const claw = container();
    claw.Config.Image = remoteDeployments.openclaw.image;
    claw.Mounts[0].Destination = "/home/node/.openclaw";
    claw.Mounts.push({ Type: "volume", Name: "test-private-volume", Destination: "/home/node" });
    claw.HostConfig.Mounts.push({ Type: "volume", Source: "test-private-volume", Target: "/home/node", VolumeOptions: { Subpath: ".agent-lab-desktop/home", NoCopy: true } });
    claw.NetworkSettings.Ports = { "18789/tcp": [{ HostIp: "127.0.0.1", HostPort: "19000" }] };
    expect(containerEndpoint(claw, "test-owner", "test-private-volume", "openclaw")).toBe("http://127.0.0.1:19000");
    expect(() => containerEndpoint(claw, "test-owner", "test-private-volume", "openhands")).toThrow();
  });
  it("rejects another volume, whole-volume HOME or an unexpected home subpath", () => {
    const claw = container();
    claw.Config.Image = remoteDeployments.openclaw.image;
    claw.Mounts[0].Destination = "/home/node/.openclaw";
    claw.Mounts.push({ Type: "volume", Name: "test-private-volume", Destination: "/home/node" });
    claw.HostConfig.Mounts.push({ Type: "volume", Source: "test-private-volume", Target: "/home/node", VolumeOptions: { Subpath: ".agent-lab-desktop/home", NoCopy: true } });
    claw.NetworkSettings.Ports = { "18789/tcp": [{ HostIp: "127.0.0.1", HostPort: "19000" }] };
    for (const patch of [{ Type: "bind" }, { Name: "foreign" }]) {
      const changed = structuredClone(claw); Object.assign(changed.Mounts[1], patch);
      expect(() => containerEndpoint(changed, "test-owner", "test-private-volume", "openclaw")).toThrow("挂载");
    }
    for (const subpath of ['', 'workspace']) {
      const changed = structuredClone(claw); changed.HostConfig.Mounts[0].VolumeOptions!.Subpath = subpath;
      expect(() => containerEndpoint(changed, "test-owner", "test-private-volume", "openclaw")).toThrow("挂载");
    }
    const prior = structuredClone(claw); prior.Config.Image = remoteDeployments.openclaw.legacyImages.at(-1)!;
    expect(containerEndpoint(prior, "test-owner", "test-private-volume", "openclaw")).toBe("http://127.0.0.1:19000");
    prior.Mounts.pop();
    expect(containerEndpoint(prior, "test-owner", "test-private-volume", "openclaw")).toBe("http://127.0.0.1:19000");
  });
  it("accepts only known owned prior images for a volume-preserving deployment upgrade", () => {
    const prior = container(); prior.Config.Image = remoteDeployments.openhands.legacyImages[1];
    expect(containerEndpoint(prior, "test-owner", "test-private-volume")).toBe("http://127.0.0.1:18000");
    prior.Config.Image = "agent-lab/openhands-agent-server:unrelated";
    expect(() => containerEndpoint(prior, "test-owner", "test-private-volume")).toThrow("不属于");
  });
  it("adopts exact previously pinned images and owner labels without relaxing mount isolation", () => {
    const prior = container();
    prior.Config.Image = "selfme-lab/openhands-agent-server:1.53.0-source-54daf056bd86-lab9";
    prior.Config.Labels = { "ai.selfme.lab.owner": "test-owner" };
    expect(containerEndpoint(prior, "test-owner", "test-private-volume")).toBe("http://127.0.0.1:18000");
    prior.Config.Labels["ai.agent-lab.desktop.owner"] = "foreign";
    expect(() => containerEndpoint(prior, "test-owner", "test-private-volume")).toThrow("不属于");
  });
});
