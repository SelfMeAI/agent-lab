import type { AgentSessionQueue, FollowUpMode, RuntimePhase } from "../../../../../../packages/contracts/src/index";

export type ComposerAction = "send" | "queue" | "steer" | "wait";

export function composerAction(phase: RuntimePhase, queue: AgentSessionQueue, mode: FollowUpMode): ComposerAction {
  if (phase === "running" || phase === "approval") return mode === "steer" ? "steer" : "queue";
  if (phase === "starting" || phase === "cancelling") return "wait";
  // A saved backlog must not be bypassed by a fresh composer message.
  if (queue.messages.some((item) => item.state !== "awaiting")) return "queue";
  // sendSessionPrompt already restarts failed/idle adapters and resumes their
  // native context. Don't require a page/session switch to unlock recovery.
  return ["ready", "idle", "error"].includes(phase) ? "send" : "wait";
}

/** UI locks are separate from saved follow-up preference and queue pause. */
export function followUpAvailability(phase: RuntimePhase, pending: {
  connecting?: boolean; stopping?: boolean; submitting?: boolean; changingMode?: boolean;
} = {}) {
  const transitioning = !!pending.connecting || !!pending.stopping || phase === "starting" || phase === "cancelling";
  const handingOff = !!pending.submitting || !!pending.changingMode;
  return {
    canSubmit: !transitioning && !handingOff,
    canChooseMode: !transitioning && !handingOff,
    canSteer: !transitioning && !handingOff && (phase === "running" || phase === "approval"),
    canResumeQueue: !transitioning && !handingOff,
  };
}
