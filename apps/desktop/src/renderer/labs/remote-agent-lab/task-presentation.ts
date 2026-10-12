import type { RemoteFailure, RemoteItem, RemoteTaskSnapshot } from "../../../../../../packages/contracts/src/remote-agent";

export const remoteTaskLabels = { idle: "待命", running: "工作中", waiting: "待确认", paused: "已停止", completed: "已完成", error: "本轮中断" };

/** Link recovery to the current native failure only; old failures remain history. */
export function activeRemoteFailure(snapshot?: RemoteTaskSnapshot): { failure: RemoteFailure; itemId?: string } | undefined {
  if (!snapshot || snapshot.task.status !== "error") return;
  let item: RemoteItem | undefined;
  for (const candidate of [...snapshot.items].reverse()) {
    if (candidate.role === "user") break;
    if (candidate.failure && (!snapshot.failure?.runId || candidate.failure.runId === snapshot.failure.runId)) { item = candidate; break; }
  }
  return { failure: item?.failure ?? snapshot.failure ?? { message: "", at: snapshot.task.updatedAt }, itemId: item?.id };
}

export function remoteFailureSummary(message: string): string {
  if (!message.trim()) return "本轮没有正常结束，暂时无法读取具体原因。";
  if (/incomplete or malformed tool call|invalid.*tool.?call|malformed.*tool.?call/i.test(message)) return "模型返回的工具调用不完整或格式不正确，本轮执行已中断。";
  if (/\b(?:401|403)\b|authentication|unauthorized|invalid.api.?key|no API key/i.test(message)) return "模型服务未接受本次请求，请先检查模型连接配置。";
  if (/\b(?:429|529)\b|rate.limit|overloaded/i.test(message)) return "模型服务暂时繁忙，本轮未能继续。请稍后再试。";
  if (/\b(?:408|504|524)\b|timed?\s*out|timeout/i.test(message)) return "等待服务响应超时，本轮执行已中断。";
  if (/context.{0,15}(?:length|limit|exceed)|too many tokens/i.test(message)) return "本次请求超过模型的上下文限制，请调整要求后继续。";
  return "本轮执行未能继续。具体原因可在错误详情中查看。";
}
