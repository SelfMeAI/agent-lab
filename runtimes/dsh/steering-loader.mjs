import { registerHooks } from "node:module";
import { replaceOnce, parseSteeringSource } from "../steering-bridge.mjs";

// Locked by runtimes/dsh/package-lock.json (dsh-acp 0.1.2-rc.1).
export function transformDsh(source) {
  source = parseSteeringSource + source;
  source = replaceOnce(source, "\tonInboxClaimed(message, turn) {", `
  selfmeSteering = new Map();
  selfmeSteer(params) {
    const active = this.inflight;
    if (this.closing || !active || active.turn === undefined || active.cancelRequested || active.endReason
      || this.agent.status !== "running" || this.agent.phase?.abort?.signal?.aborted)
      throw new Error("当前任务已结束或正在取消，补充指令未提交");
    const message = createUserMessage({ content: [{ type: "text", text: params.text }], source: { kind: "user" } });
    this.selfmeSteering.set(message.id, { messageId: params.messageId, turn: active.turn });
    // Guard and native steer are synchronous: never falls back to followup/new turn.
    try { this.agent.steer(message); }
    catch (error) { this.selfmeSteering.delete(message.id); throw error; }
    return { accepted: true };
  }
  onInboxClaimed(message, turn) {
    const steering = this.selfmeSteering.get(message.id);
    if (steering) {
      this.selfmeSteering.delete(message.id);
      void this.notify({ sessionId: this.agent.session.id, update: {
        sessionUpdate: "selfme_steering", messageId: steering.messageId,
        state: turn === steering.turn ? "incorporated" : "unconfirmed",
        detail: turn === steering.turn ? "已接入本轮任务" : "未确认接入原任务"
      }});
    }`);
  source = replaceOnce(source, "\t\tasync prompt(params, requestSignal) {", `
    selfmeSteer(params) {
      assertOpen();
      return requireSession(brandString(params.sessionId)).selfmeSteer(params);
    },
    async prompt(params, requestSignal) {`);
  source = replaceOnce(source, ".onNotification(methods.agent.session.cancel,", `.onRequest("_selfme/steer", selfmeParseSteering, ({ params }) => implementation.selfmeSteer(params)).onNotification(methods.agent.session.cancel,`);
  return source;
}

if (process.env.SELFME_ACP_STEERING === "1") registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/@deepseek-ai/dsh-acp/lib/index.js")) return result;
    return { ...result, source: transformDsh(String(result.source)) };
  },
});
