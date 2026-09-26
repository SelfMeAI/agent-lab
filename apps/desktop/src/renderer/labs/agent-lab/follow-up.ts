import type { AgentSessionQueue, FollowUpMode, RuntimePhase } from "../../../../../../packages/contracts/src/index";

export type ComposerAction = "send" | "queue" | "steer" | "wait";

export function composerAction(phase: RuntimePhase, queue: AgentSessionQueue, mode: FollowUpMode): ComposerAction {
  if (phase === "running" || phase === "approval") return mode === "steer" ? "steer" : "queue";
  if (phase === "starting" || phase === "cancelling") return mode === "queue" ? "queue" : "wait";
  // A saved backlog must not be bypassed by a fresh composer message.
  if (queue.messages.some((item) => item.state !== "awaiting")) return "queue";
  return phase === "ready" ? "send" : "wait";
}
