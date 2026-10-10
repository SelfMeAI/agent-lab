import type { RemoteModelConnection, RemoteModelInput, RemoteServiceState } from "../../../../../packages/contracts/src/remote-agent";
import { redactServiceOutput } from "./deployment";

type Action = "start" | "stop" | "restart";
interface ContainerPort { state(): Promise<RemoteServiceState>; control(action: Action): Promise<RemoteServiceState>; logs(): Promise<string> }
interface ModelPort { get(): Promise<RemoteModelConnection>; save(input: RemoteModelInput): Promise<RemoteModelConnection> }

/** Coordinates dev lifecycle and first configuration across route/client remounts. */
export class RemoteDevelopmentService {
  private action: Action | null = null;
  private saving = false;
  private warning: string | undefined;
  constructor(private readonly container: ContainerPort, private readonly model: ModelPort,
    private readonly initialConnection: () => Promise<RemoteModelInput | null>) {}

  async state(): Promise<RemoteServiceState> {
    const state = await this.container.state();
    return { ...state, ...(this.action ? { phase: this.action === "stop" ? "stopping" as const : "starting" as const, detail: this.action === "stop" ? "正在停止服务" : "正在启动并准备连接" } : {}), setupWarning: this.warning ?? state.setupWarning };
  }
  async control(action: Action): Promise<RemoteServiceState> {
    this.assertIdle(); this.action = action; this.warning = undefined;
    try {
      const state = await this.container.control(action);
      if (action !== "stop" && state.phase === "ready") {
        try {
          if (!(await this.model.get()).configured) {
            const connection = await this.initialConnection();
            if (connection?.apiKey) await this.model.save(connection);
          }
        } catch (error) { this.warning = `模型连接需检查：${redactServiceOutput(error instanceof Error ? error.message : String(error))}`; }
      }
    } finally { this.action = null; }
    return this.state();
  }
  private assertIdle(): void { if (this.action || this.saving) throw new Error("服务正在处理中，请等待操作完成"); }
  getModel(): Promise<RemoteModelConnection> { this.assertIdle(); return this.model.get(); }
  async saveModel(input: RemoteModelInput): Promise<RemoteModelConnection> {
    this.assertIdle(); this.saving = true;
    try { const result = await this.model.save(input); this.warning = undefined; return result; }
    catch (error) { throw new Error(redactServiceOutput(error instanceof Error ? error.message : String(error), [input?.apiKey ?? ""])); }
    finally { this.saving = false; }
  }
  logs(): Promise<string> { return this.container.logs(); }
}
