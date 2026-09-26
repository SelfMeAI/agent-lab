import { registerHooks } from "node:module";
import { replaceOnce, parseSteeringSource } from "../steering-bridge.mjs";

// Official npm @moonshot-ai/kimi-code 2.1.1. Keep ACP, approvals and native loop unchanged.
export function transformKimi(source) {
  source = parseSteeringSource + source.replace(/^#![^\n]*\n/u, "");
  const head = '\t\tasync submitSteer(payload) {\n\t\t\tthis.telemetry.track2("input_steer", { parts: payload.input.length });\n\t\t\tawait this.updateMetadata(promptMetadataTextFromContentParts(payload.input));\n\t\t\tconst status = this.loop.snapshot();';
  source = replaceOnce(source, head, head + `
    // Normal native steer also starts a turn when idle. This ACP-only process
    // forbids that fallback, atomically after the async metadata update.
    if (status.state !== "running" || status.activePromptId === undefined || status.paused
      || !globalThis.__selfmeSteeringGuards?.get(this.sessionContext.sessionId)?.())
      throw new Error("当前任务已结束，补充指令未提交；不会自动启动新任务");`);
  source = replaceOnce(source, "\t\tassertNoActiveTurn() {", `
  selfmeSteer(params) {
    const driver = this.driver;
    if (!driver || driver.settled || driver.cancelRequested || driver.turnId === undefined)
      throw new Error("当前任务尚未开始、已结束或正在取消，补充指令未提交");
    const receipt = (state, detail) => this.conn.sessionUpdate({ sessionId: this.sessionId,
      update: { sessionUpdate: "selfme_steering", messageId: params.messageId, state, detail }
    }).catch(() => {});
    (globalThis.__selfmeSteeringGuards ??= new Map()).set(this.sessionId,
      () => this.driver === driver && !driver.settled && !driver.cancelRequested);
    // Do NOT call prompt/driveLaunch or replace the active driver.
    void this.agent.steer({ input: [{ type: "text", text: params.text }] }).then(result => {
      if (result && result.turn_id === driver.turnId) return receipt("incorporated", "已接入本轮任务");
      return receipt("unconfirmed", "未确认接入本轮任务");
    }, () => receipt("unconfirmed", "补充指令未接入；任务可能已结束或取消"));
    return { accepted: true };
  }
  assertNoActiveTurn() {`);
  // Upstream only marks deferred (pre-turn-id) cancellation. Mark every
  // cancellation synchronously so an async metadata write cannot admit a
  // supplemental input after cancellation has already been requested.
  const cancelGuard = '\t\t\tif (driver === void 0 || driver.settled) return;\n\t\t\tconst turnId = driver.turnId;';
  source = replaceOnce(source, cancelGuard, '\t\t\tif (driver === void 0 || driver.settled) return;\n\t\t\tdriver.cancelRequested = true;\n\t\t\tconst turnId = driver.turnId;');
  source = replaceOnce(source, ".onNotification(methods.agent.session.cancel,", `.onRequest("_selfme/steer", selfmeParseSteering, ({ params }) => {
    const session = getServer().sessions.get(params.sessionId);
    if (!session) throw new Error("会话不存在");
    return session.selfmeSteer(params);
  }).onNotification(methods.agent.session.cancel,`);
  return source;
}

if (process.env.SELFME_ACP_STEERING === "1") registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/@moonshot-ai/kimi-code/dist/main.mjs")) return result;
    return { ...result, source: transformKimi(String(result.source)) };
  },
});
