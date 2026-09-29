import { Chess } from "@weshell/xiangqi.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./provider-store", () => ({ getJevProvider: vi.fn() }));

import { getJevProvider } from "./provider-store";
import { decideJevMove } from "./jev-decision";

const provider = vi.mocked(getJevProvider);

afterEach(() => {
  vi.unstubAllGlobals();
  provider.mockReset();
});

describe("JEV decision boundary", () => {
  it("marks a keyless local fallback without claiming online JEV", async () => {
    provider.mockResolvedValue({ baseUrl: "https://api.typesafe.ai", model: "jev-latest" });
    const decision = await decideJevMove(new Chess().fen(), "balanced");
    expect(decision.telemetry.source).toBe("local-fallback");
    expect(decision.warning).toContain("API Key");
    expect(decision.telemetry.positionScore).toBeNull();
    expect(decision.telemetry.tacticalPressure).toBeNull();
    expect(decision.telemetry.inputTokens).toBeNull();
    expect(decision.telemetry.candidates.some((candidate) => candidate.id === decision.move.id)).toBe(true);
  });

  it("accepts an online choice only when it is a legal move", async () => {
    provider.mockResolvedValue({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "test-only-key" });
    const chess = new Chess();
    const selected = (chess.moves({ verbose: true }) as unknown as { lan: string }[])[0].lan;
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ model: "jev-latest", answers: { selected_move: { choice: selected, confidence: .7, probabilities: { [selected]: .6 } }, position_outlook: { score: 3, confidence: .8 }, tactical_pressure: { noul: .4 } }, usage: { input_tokens: 12, output_tokens: 3 } }) }));
    vi.stubGlobal("fetch", fetchMock);
    const decision = await decideJevMove(chess.fen(), "aggressive");
    expect(decision.telemetry.source).toBe("jev");
    expect(decision.move.id).toBe(selected);
    expect(decision.telemetry.inputTokens).toBe(12);
    expect(decision.telemetry.probabilities).toEqual({ [selected]: .6 });
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(options.body as string).questions.selected_move.criteria[selected]).toBeTruthy();
  });

  it("leaves missing online measurements empty instead of replacing them with local estimates or zero", async () => {
    provider.mockResolvedValue({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "test-only-key" });
    const chess = new Chess();
    const selected = (chess.moves({ verbose: true }) as unknown as { lan: string }[])[0].lan;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ answers: { selected_move: { choice: selected, probabilities: {} } } }) })));
    const decision = await decideJevMove(chess.fen(), "balanced");
    expect(decision.telemetry.source).toBe("jev");
    expect(decision.telemetry.probabilities).toEqual({});
    expect(decision.telemetry.choiceConfidence).toBeNull();
    expect(decision.telemetry.positionScore).toBeNull();
    expect(decision.telemetry.positionConfidence).toBeNull();
    expect(decision.telemetry.tacticalPressure).toBeNull();
    expect(decision.telemetry.inputTokens).toBeNull();
    expect(decision.telemetry.outputTokens).toBeNull();
  });

  it("preserves real zero measurements from JEV", async () => {
    provider.mockResolvedValue({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "test-only-key" });
    const chess = new Chess();
    const selected = (chess.moves({ verbose: true }) as unknown as { lan: string }[])[0].lan;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ answers: { selected_move: { choice: selected, confidence: 0, probabilities: { [selected]: 0 } }, position_outlook: { score: 0, confidence: 0 }, tactical_pressure: { noul: 0 } }, usage: { input_tokens: 0, output_tokens: 0 } }) })));
    const decision = await decideJevMove(chess.fen(), "balanced");
    expect(decision.telemetry.choiceConfidence).toBe(0);
    expect(decision.telemetry.probabilities).toEqual({ [selected]: 0 });
    expect(decision.telemetry.positionScore).toBe(0);
    expect(decision.telemetry.positionConfidence).toBe(0);
    expect(decision.telemetry.tacticalPressure).toBe(0);
    expect(decision.telemetry.inputTokens).toBe(0);
    expect(decision.telemetry.outputTokens).toBe(0);
  });

  it("rejects invalid online choices by visibly falling back", async () => {
    provider.mockResolvedValue({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "test-only-key" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ answers: { selected_move: { choice: "not-a-legal-move" } } }) })));
    const decision = await decideJevMove(new Chess().fen(), "balanced");
    expect(decision.telemetry.source).toBe("local-fallback");
    expect(decision.warning).toContain("合法候选");
  });
});
