import { Chess } from "@weshell/xiangqi.js";
import type { JevCandidate, JevDecision, JevStyle } from "../../../../packages/contracts/src/index";
import { getJevProvider } from "./provider-store";

type Color = "w" | "b";
type EngineMove = {
  color: Color; from: string; to: string; piece: string; captured?: string;
  zh: string; lan: string; isCheck: boolean; isCheckmate: boolean;
};
type BoardPiece = { square: string; type: string; color: Color };
type JevAnswer = { choice?: string; confidence?: number; probabilities?: Record<string, number>; score?: number; noul?: number };
type JevPayload = {
  model?: string;
  answers?: { selected_move?: JevAnswer; position_outlook?: JevAnswer; tactical_pressure?: JevAnswer };
  usage?: { input_tokens?: number; output_tokens?: number };
  detail?: { message?: string };
};

const pieceNames: Record<string, string> = {
  k: "general", a: "advisor", b: "elephant", n: "horse", r: "rook", c: "cannon", p: "pawn",
};

const styles: Record<JevStyle, { label: string; instruction: string }> = {
  balanced: {
    label: "Balanced",
    instruction: "Keep king safety and material sound while looking for clear initiative.",
  },
  aggressive: {
    label: "Aggressive",
    instruction: "Favor forcing moves, attacks on the opposing king, initiative, and tactical pressure when they remain safe.",
  },
  positional: {
    label: "Positional",
    instruction: "Favor king safety, durable piece activity, central control, and avoiding unsound exchanges.",
  },
};

function pieceName(piece: string | undefined): string { return pieceNames[piece ?? ""] ?? "piece"; }

function describeBoard(chess: Chess): string {
  return (chess.board() as unknown as (BoardPiece | null)[][])
    .flat()
    .filter((piece): piece is BoardPiece => piece !== null)
    .map((piece) => `${piece.color === "w" ? "Red" : "Black"} ${pieceName(piece.type)} at ${piece.square}`)
    .join("; ");
}

function candidateFor(move: EngineMove): JevCandidate {
  const effects = [`${move.color === "w" ? "Red" : "Black"} ${pieceName(move.piece)} moves from ${move.from} to ${move.to}.`];
  if (move.captured) effects.push(`Captures a ${pieceName(move.captured)}.`);
  if (move.isCheckmate) effects.push("Delivers checkmate.");
  else if (move.isCheck) effects.push("Gives check.");
  else effects.push("No immediate check is recorded.");
  return {
    id: move.lan, color: move.color, from: move.from, to: move.to, lan: move.lan, zh: move.zh,
    piece: move.piece, capture: move.captured, givesCheck: move.isCheck, isCheckmate: move.isCheckmate,
    description: effects.join(" "),
  };
}

function fallback(candidates: JevCandidate[], style: JevStyle) {
  const values: Record<string, number> = { p: 1, a: 2, b: 2, n: 4, c: 4.5, r: 9, k: 100 };
  const scored = candidates.map((candidate, index) => {
    const vertical = Number(candidate.to[1]) - Number(candidate.from[1]);
    const forward = candidate.color === "w" ? vertical : -vertical;
    const score = (candidate.isCheckmate ? 80 : 0) + (candidate.givesCheck ? 10 : 0)
      + (candidate.capture ? values[candidate.capture] ?? 1 : 0)
      + (candidate.to[0] === "e" ? 1.5 : 0)
      + (style === "aggressive" ? Math.max(0, forward) * 0.35 : 0)
      + Math.max(0, 0.15 - index / 1000);
    return { candidate, score };
  }).sort((left, right) => right.score - left.score);
  const max = scored[0]?.score ?? 0;
  const weights = scored.map(({ score }) => Math.exp((score - max) / 2.5));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  const probabilities = Object.fromEntries(scored.map(({ candidate }, index) => [candidate.id, Number((weights[index] / total).toFixed(4))]));
  const top = scored[0]?.candidate ?? candidates[0];
  const topProbability = probabilities[top.id] ?? 0;
  const confidence = candidates.length <= 1 ? 1 : Math.max(0, (candidates.length * topProbability - 1) / (candidates.length - 1));
  return { top, probabilities, confidence: Number(confidence.toFixed(3)) };
}

function fallbackDecision(candidates: JevCandidate[], style: JevStyle, startedAt: number, warning: string): JevDecision {
  const local = fallback(candidates, style);
  return {
    move: local.top,
    telemetry: {
      source: "local-fallback", model: "Local deterministic fallback",
      durationMs: Math.round(performance.now() - startedAt), inputTokens: null, outputTokens: null,
      choiceConfidence: local.confidence, probabilities: local.probabilities,
      positionScore: null, positionConfidence: null, tacticalPressure: null, candidates,
    },
    warning,
  };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function probabilitiesFor(raw: Record<string, number> | undefined, candidates: JevCandidate[]): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const allowed = new Set(candidates.map((candidate) => candidate.id));
  const entries = Object.entries(raw).filter(([id, probability]) => allowed.has(id) && typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1);
  return Object.fromEntries(entries);
}

export async function decideJevMove(fen: string, style: JevStyle): Promise<JevDecision> {
  if (typeof fen !== "string" || fen.length > 300 || !["balanced", "aggressive", "positional"].includes(style)) {
    throw new Error("棋局或风格参数无效");
  }
  const chess = new Chess(fen);
  if (chess.isGameOver()) throw new Error("棋局已经结束");
  const candidates = (chess.moves({ verbose: true }) as unknown as EngineMove[]).map(candidateFor);
  if (!candidates.length) throw new Error("当前没有合法着法");
  const startedAt = performance.now();
  const provider = await getJevProvider();
  if (!provider.apiKey) return fallbackDecision(candidates, style, startedAt, "JEV API Key 尚未配置，已使用明确标记的本地规则回退");

  const side = chess.turn() === "w" ? "Red" : "Black";
  const criteria = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.description]));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${provider.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model,
        state: {
          game: "Chinese chess (Xiangqi)", side_to_move: side, fen: chess.fen(), board: describeBoard(chess),
          legal_move_count: candidates.length, player_style: styles[style].label,
        },
        questions: {
          selected_move: {
            type: "choice",
            instructions: {
              question: `Choose the strongest legal move for ${side}.`,
              player_style: styles[style].instruction,
              rule: "All listed options are legal. Choose one option only. Prioritize immediate mate and king safety over unsupported attacks.",
            },
            criteria,
          },
          position_outlook: {
            type: "score",
            instructions: `Evaluate the current position from ${side}'s perspective before the selected move.`,
            criteria: [
              "Lost or close to lost", "Disadvantaged", "Roughly equal",
              "Advantageous", "Winning or has a decisive tactical opportunity",
            ],
          },
          tactical_pressure: {
            type: "noul",
            instructions: `Does ${side} have immediate tactical pressure against the opposing general in the current position?`,
          },
        },
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    const payload = await response.json() as JevPayload;
    if (!response.ok || !payload.answers?.selected_move?.choice) throw new Error(payload.detail?.message ?? `JEV HTTP ${response.status}`);
    const selected = candidates.find((candidate) => candidate.id === payload.answers?.selected_move?.choice);
    if (!selected) throw new Error("JEV 返回了不在合法候选列表中的着法");
    return {
      move: selected,
      telemetry: {
        source: "jev", model: payload.model ?? provider.model,
        durationMs: Math.round(performance.now() - startedAt),
        inputTokens: finite(payload.usage?.input_tokens), outputTokens: finite(payload.usage?.output_tokens),
        choiceConfidence: finite(payload.answers.selected_move.confidence),
        probabilities: probabilitiesFor(payload.answers.selected_move.probabilities, candidates),
        positionScore: finite(payload.answers.position_outlook?.score),
        positionConfidence: finite(payload.answers.position_outlook?.confidence),
        tacticalPressure: finite(payload.answers.tactical_pressure?.noul),
        candidates,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "JEV 请求失败";
    return fallbackDecision(candidates, style, startedAt, message.replaceAll(provider.apiKey, "[redacted]"));
  } finally {
    clearTimeout(timer);
  }
}
