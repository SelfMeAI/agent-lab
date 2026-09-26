import type { RunEvent } from "../../contracts/src/index";

export function steeringError(error: unknown, secret?: string | null): Error {
  const text = error instanceof Error ? error.message : String(error);
  return new Error(secret ? text.replaceAll(secret, "[redacted]") : text);
}

/** Native handoff receipts, not an app-owned follow-up/task queue. */
export class SteeringTracker {
  private readonly pending = new Map<string, string>();
  constructor(private readonly emit: (extra: Partial<RunEvent>) => void) {}

  begin(messageId: string, prompt: string): string {
    const text = prompt.trim();
    if (!text) throw new Error("请输入补充指令");
    if (text.length > 100000) throw new Error("补充指令过长，请拆分后提交");
    if (this.pending.size >= 10) throw new Error("已有 10 条补充等待接入，请稍候再提交");
    if (this.pending.has(messageId)) throw new Error("补充指令已提交");
    this.pending.set(messageId, text);
    return text;
  }

  accepted(messageId: string): void {
    if (this.pending.has(messageId)) this.emit({ messageId, deliveryState: "queued", text: "已提交，等待接入本轮任务" });
  }

  incorporated(messageId: string): void {
    if (!this.pending.delete(messageId)) return;
    this.emit({ messageId, deliveryState: "incorporated", text: "已接入本轮任务" });
  }

  match(text: string): void {
    const match = [...this.pending].find(([, prompt]) => prompt === text.trim());
    if (match) this.incorporated(match[0]);
  }

  unconfirmed(messageId: string, detail: string): void {
    if (!this.pending.delete(messageId)) return;
    this.emit({ messageId, deliveryState: "unconfirmed", text: detail });
  }

  rejected(messageId: string, error: unknown): void {
    if (!this.pending.delete(messageId)) return;
    const detail = error instanceof Error ? error.message : String(error);
    const uncertain = /timeout|超时|连接|退出|停止/iu.test(detail);
    this.emit({ messageId, deliveryState: uncertain ? "unconfirmed" : "rejected", text: detail });
  }

  finish(detail = "本轮已结束，未确认接入；不会自动作为新任务执行"): void {
    for (const id of [...this.pending.keys()]) this.unconfirmed(id, detail);
  }
}
