/** Version-pinned, in-memory ACP extensions. Never modifies installed upstream files. */
export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("ACP steering bridge: upstream signature changed; refusing to patch");
  return source.replace(before, after);
}

export const parseSteeringSource = `function agentLabParseSteering(params) {
  if (!params || typeof params.sessionId !== "string" || typeof params.messageId !== "string"
    || !/^[a-zA-Z0-9-]{1,100}$/.test(params.messageId) || typeof params.text !== "string"
    || !params.text.trim() || params.text.length > 100000) throw new Error("Invalid steering request");
  return { sessionId: params.sessionId, messageId: params.messageId, text: params.text.trim() };
}\n`;
