import { registerHooks } from "node:module";
import { replaceOnce, parseSteeringSource } from "../steering-bridge.mjs";

// Locked by runtimes/dsh/package-lock.json (dsh-acp 0.1.2-rc.1).
export function transformDsh(source) {
  source = parseSteeringSource + source;
  // Adapt the native userQuestions seam; do not replace its tool or agent loop.
  // The pinned ACP server has an approval bridge but no human-question bridge.
  source = replaceOnce(source, '\tctx.on("approval/request", (request, next) => {', `
  ctx.on("user-questions/request", async (request, next) => {
    const record = request.agent === undefined ? undefined : ownedRecord(request.agent);
    if (record === undefined) return next();
    await record.drainUpdates();
    if (request.signal?.aborted) throw new Error("用户提问已取消");
    const response = await conn.request("_agent_lab/user-question", {
      sessionId: record.agent.session.id, questions: request.questions
    }, { signal: request.signal });
    if (response.cancelled || request.signal?.aborted) throw new Error("用户已取消回答");
    return { answers: response.answers };
  });
  ctx.on("approval/request", (request, next) => {`);
  source = replaceOnce(source, "\tonInboxClaimed(message, turn) {", `
  agentLabSteering = new Map();
  agentLabSteer(params) {
    const active = this.inflight;
    if (this.closing || !active || active.turn === undefined || active.cancelRequested || active.endReason
      || this.agent.status !== "running" || this.agent.phase?.abort?.signal?.aborted)
      throw new Error("当前任务已结束或正在取消，补充指令未提交");
    const message = createUserMessage({ content: [{ type: "text", text: params.text }], source: { kind: "user" } });
    this.agentLabSteering.set(message.id, { messageId: params.messageId, turn: active.turn });
    // Guard and native steer are synchronous: never falls back to followup/new turn.
    try { this.agent.steer(message); }
    catch (error) { this.agentLabSteering.delete(message.id); throw error; }
    return { accepted: true };
  }
  onInboxClaimed(message, turn) {
    const steering = this.agentLabSteering.get(message.id);
    if (steering) {
      this.agentLabSteering.delete(message.id);
      void this.notify({ sessionId: this.agent.session.id, update: {
        sessionUpdate: "agent_lab_steering", messageId: steering.messageId,
        state: turn === steering.turn ? "incorporated" : "unconfirmed",
        detail: turn === steering.turn ? "已接入本轮任务" : "未确认接入原任务"
      }});
    }`);
  source = replaceOnce(source, "\t\tasync prompt(params, requestSignal) {", `
    agentLabSteer(params) {
      assertOpen();
      return requireSession(brandString(params.sessionId)).agentLabSteer(params);
    },
    async prompt(params, requestSignal) {`);
  source = replaceOnce(source, ".onNotification(methods.agent.session.cancel,", `.onRequest("_agent_lab/steer", agentLabParseSteering, ({ params }) => implementation.agentLabSteer(params)).onNotification(methods.agent.session.cancel,`);
  return source;
}

if (process.env.AGENT_LAB_ACP_STEERING === "1") registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/@deepseek-ai/dsh-acp/lib/index.js")) return result;
    return { ...result, source: transformDsh(String(result.source)) };
  },
});
