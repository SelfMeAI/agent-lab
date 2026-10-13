import { describe, expect, it, vi } from "vitest";
import { DocumentPreviewService, documentPreviewDefinition } from "./document-preview-service";
const owner = "0123456789abcdef";

function fixture(change?: (value: Record<string, unknown>) => void) {
  let network: unknown = null;
  let container: Record<string, unknown> | null = null;
  const command = vi.fn(async (args: string[]) => {
    if (args[0] === "network" && args[1] === "inspect") { if (!network) throw new Error("no such network"); return JSON.stringify([network]); }
    if (args[0] === "network" && args[1] === "create") { network = { Internal: true, Driver: "bridge", Labels: { "ai.agent-lab.desktop.owner": owner } }; return "network-id"; }
    if (args[0] === "container" && args[1] === "inspect") { if (!container) throw new Error("No such container"); return JSON.stringify([container]); }
    if (args[0] === "image") return "[]";
    if (args[0] === "run") {
      container = { Config: { Image: documentPreviewDefinition.image, Labels: { "ai.agent-lab.desktop.owner": owner, "ai.agent-lab.desktop.deployment": service.revision } }, State: { Running: true }, Mounts: [], NetworkSettings: { Networks: { [service.network]: {} }, Ports: { "3000/tcp": null } } };
      change?.(container); return "container-id";
    }
    return "";
  });
  const service = new DocumentPreviewService(owner, command);
  return { command, service, setNetwork: (value: unknown) => { network = value; } };
}
describe("isolated remote office renderer", () => {
  it("uses a digest-pinned official renderer and disables unrelated routes and outbound fetching", () => {
    expect(documentPreviewDefinition.image).toMatch(/^gotenberg\/gotenberg:8\.34\.0@sha256:[a-f0-9]{64}$/);
    expect(documentPreviewDefinition.command).toContain("--libreoffice-deny-list=.*");
    expect(documentPreviewDefinition.command).toContain("--api-disable-download-from=true");
    expect(documentPreviewDefinition.command).toContain("--webhook-disable=true");
    expect(documentPreviewDefinition.command).toContain("--chromium-disable-routes=true");
  });
  it("runs on an internal network without publishing ports, mounting data or injecting model credentials", async () => {
    const { service, command } = fixture(); await service.start();
    const args = command.mock.calls.find(([args]) => args[0] === "run")![0];
    expect(args).toContain(service.network); expect(args).toContain("no-new-privileges:true");
    for (const option of ["--publish", "--mount", "--env", "--privileged"]) expect(args).not.toContain(option);
    expect(command.mock.calls.find(([args]) => args[1] === "create")![0]).toContain("--internal");
    expect(service.url).toBe("http://agent-lab-document-preview-0123456789abcdef:3000");
  });
  it("reuses one renderer when both engines request it concurrently", async () => {
    const { service, command } = fixture(); await Promise.all([service.start(), service.start()]); await service.start();
    expect(command.mock.calls.filter(([args]) => args[0] === "run")).toHaveLength(1);
  });
  it("refuses networks belonging to another app or with outbound routing", async () => {
    for (const network of [{ Internal: true, Driver: "bridge", Labels: {} }, { Internal: false, Driver: "bridge", Labels: { "ai.agent-lab.desktop.owner": owner } }]) {
      const { service, command, setNetwork } = fixture(); setNetwork(network);
      await expect(service.start()).rejects.toThrow("隔离规则");
      expect(command.mock.calls.some(([args]) => args[0] === "run")).toBe(false);
    }
  });
  it("refuses an owned-name container that exposes ports or mounts another user's data", async () => {
    for (const change of [(value: Record<string, unknown>) => { value.Mounts = [{ Source: "/host" }]; }, (value: Record<string, unknown>) => { value.NetworkSettings = { Networks: { "other-network": {} }, Ports: {} }; }]) {
      const { service } = fixture(change); await service.start(); await expect(service.start()).rejects.toThrow("隔离规则");
    }
  });
});
