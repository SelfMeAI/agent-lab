import { createHash } from "node:crypto";
import definition from "../../../../../services/remote-agent/document-preview/service.json";
import { ownedResource } from "../application-identity";

type Command = (args: string[], timeout?: number) => Promise<string>;
type Network = { Internal: boolean; Driver: string; Labels?: Record<string, string> };
type PreviewContainer = {
  Config: { Image: string; Labels?: Record<string, string> };
  State: { Running: boolean };
  Mounts: unknown[];
  NetworkSettings: { Networks: Record<string, unknown>; Ports: Record<string, unknown> };
};
const ownerLabel = "ai.agent-lab.desktop.owner";
const revisionLabel = "ai.agent-lab.desktop.deployment";
const starts = new Map<string, Promise<void>>();
export const documentPreviewDefinition = definition;

/** An internal, disposable renderer, not an agent and not a task data store. */
export class DocumentPreviewService {
  readonly name: string;
  readonly network: string;
  readonly url: string;
  readonly revision = createHash("sha256").update(JSON.stringify(definition)).digest("hex").slice(0, 16);
  constructor(readonly owner: string, private readonly command: Command, private readonly namespace = "agent-lab") {
    this.name = `${namespace}-document-preview-${owner}`;
    this.network = `${namespace}-document-preview-${owner}-network`;
    this.url = `http://${this.name}:${definition.port}`;
  }
  private async inspect<T>(kind: "network" | "container", name: string): Promise<T | null> {
    try { return (JSON.parse(await this.command([kind, "inspect", name])) as T[])[0] ?? null; }
    catch (error) { if (/no such (?:network|object|container)|network .* not found/i.test(String(error))) return null; throw error; }
  }
  async ensureNetwork(): Promise<void> {
    let current = await this.inspect<Network>("network", this.network);
    if (!current) {
      try { await this.command(["network", "create", "--internal", "--label", `${ownerLabel}=${this.owner}`, this.network]); }
      catch (error) { if (!/already exists/i.test(String(error))) throw error; }
      current = await this.inspect<Network>("network", this.network);
    }
    if (!current || !ownedResource(current.Labels, this.owner) || !current.Internal || current.Driver !== "bridge") throw new Error("办公文档预览网络不符合隔离规则，未作修改");
  }
  start(): Promise<void> {
    const existing = starts.get(this.owner); if (existing) return existing;
    const pending = this.startOwned().finally(() => { if (starts.get(this.owner) === pending) starts.delete(this.owner); });
    starts.set(this.owner, pending); return pending;
  }
  private assertOwned(current: PreviewContainer): void {
    if (!ownedResource(current.Config.Labels, this.owner) || current.Config.Image !== definition.image || current.Mounts.length || Object.keys(current.NetworkSettings.Networks).length !== 1 || !current.NetworkSettings.Networks[this.network] || Object.values(current.NetworkSettings.Ports).some(Boolean)) throw new Error("办公文档预览容器不符合隔离规则，未作修改");
  }
  private async startOwned(): Promise<void> {
    await this.ensureNetwork();
    let current = await this.inspect<PreviewContainer>("container", this.name);
    if (current) {
      this.assertOwned(current);
      if (current.Config.Labels?.[revisionLabel] !== this.revision) {
        if (current.State.Running) await this.command(["stop", "--time", "10", this.name]);
        await this.command(["rm", this.name]); current = null;
      }
    }
    if (current) { if (!current.State.Running) await this.command(["start", this.name]); return; }
    try { await this.command(["image", "inspect", definition.image], 8000); }
    catch (error) {
      if (!/no such image|no such object/i.test(String(error))) throw error;
      await this.command(["pull", "--quiet", definition.image], 600_000);
    }
    await this.command([
      "run", "--detach", "--name", this.name, "--label", `${ownerLabel}=${this.owner}`, "--label", `${revisionLabel}=${this.revision}`,
      "--network", this.network, "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "256", "--memory", "2g",
      definition.image, ...definition.command,
    ]);
  }
  async stopIfUnused(): Promise<void> {
    for (const engine of ["openhands", "openclaw"]) {
      const running = await this.inspect<{ State: { Running: boolean } }>("container", `${this.namespace}-${engine}-${this.owner}`);
      if (running?.State.Running) return;
    }
    const current = await this.inspect<PreviewContainer>("container", this.name);
    if (current) { this.assertOwned(current); if (current.State.Running) await this.command(["stop", "--time", "10", this.name]); }
  }
}
