import type { JevExperimentDecision, JevExperimentId } from "../../../../packages/contracts/src/index";
import { isJevExperimentId, jevExperiments } from "../jev-experiments/catalog";
import { postJevSystemOne } from "./jev-api";
import { getJevProvider } from "./provider-store";

type JevAnswer = { choice?: unknown; confidence?: unknown; probabilities?: unknown; score?: unknown; noul?: unknown };
type JevPayload = {
  model?: unknown;
  answers?: { action?: JevAnswer; urgency?: JevAnswer; anomaly?: JevAnswer };
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
};

const urgencyCriteria = [
  "No follow-up needed beyond routine closure.",
  "Normal queue; review can wait.",
  "Prompt attention is needed before normal handling continues.",
  "Immediate attention is needed for a serious or irreversible concern.",
];

function numberInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function probabilitiesFor(value: unknown, allowed: ReadonlySet<string>): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, probability]) => allowed.has(id) && numberInRange(probability, 0, 1) !== null));
}

export async function runJevExperiment(experimentId: JevExperimentId, state: string): Promise<JevExperimentDecision> {
  if (!isJevExperimentId(experimentId)) throw new Error("未知 JEV 实验项目");
  if (typeof state !== "string" || state.trim().length < 20 || state.length > 12000 || state.includes("\0")) {
    throw new Error("案例内容需为 20–12000 个字符");
  }
  const definition = jevExperiments[experimentId];
  const provider = await getJevProvider();
  const startedAt = performance.now();
  const payload = await postJevSystemOne<JevPayload>(provider, {
    model: provider.model,
    state,
    questions: {
      action: {
        type: "choice",
        instructions: definition.question,
        criteria: Object.fromEntries(definition.actions.map((action) => [action.id, action.criteria])),
      },
      urgency: {
        type: "score",
        instructions: "How urgently does the selected follow-up need attention? Rate from 0 to 3 using the provided levels.",
        criteria: urgencyCriteria,
      },
      anomaly: {
        type: "noul",
        instructions: definition.anomalyQuestion,
      },
    },
  });
  const allowed = new Set(definition.actions.map((action) => action.id));
  const actionId = payload.answers?.action?.choice;
  if (typeof actionId !== "string" || !allowed.has(actionId)) throw new Error("JEV 未返回有效的预设动作");
  return {
    experimentId,
    actionId,
    confidence: numberInRange(payload.answers?.action?.confidence, 0, 1),
    probabilities: probabilitiesFor(payload.answers?.action?.probabilities, allowed),
    urgencyScore: numberInRange(payload.answers?.urgency?.score, 0, 3),
    urgencyConfidence: numberInRange(payload.answers?.urgency?.confidence, 0, 1),
    anomalyProbability: numberInRange(payload.answers?.anomaly?.noul, 0, 1),
    model: typeof payload.model === "string" && payload.model ? payload.model : provider.model,
    durationMs: Math.round(performance.now() - startedAt),
    inputTokens: tokenCount(payload.usage?.input_tokens),
    outputTokens: tokenCount(payload.usage?.output_tokens),
  };
}
