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
    expect(decision.telemetry.candidates.some((candidate) => candidate.id === decision.move.id)).toBe(true);
  });

  it("accepts an online choice only when it is a legal move", async () => {
    provider.mockResolvedValue({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "test-only-key" });
    const chess = new Chess();
    const selected = (chess.moves({ verbose: true }) as unknown as { lan: string }[])[0].lan;
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ model: "jev-latest", answers: { selected_move: { choice: selected, confidence: .7, probabilities: {} }, position_outlook: { score: 3, confidence: .8 }, tactical_pressure: { noul: .4 } }, usage: { input_tokens: 12, output_tokens: 3 } }) }));
    vi.stubGlobal("fetch", fetchMock);
    const decision = await decideJevMove(chess.fen(), "aggressive");
    expect(decision.telemetry.source).toBe("jev");
    expect(decision.move.id).toBe(selected);
    expect(decision.telemetry.inputTokens).toBe(12);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(options.body as string).questions.selected_move.criteria[selected]).toBeTruthy();
  });

  it("rejects invalid online choices by visibly falling back", async () => {
    provider.mockResolvedValue({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "test-only-key" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ answers: { selected_move: { choice: "not-a-legal-move" } } }) })));
    const decision = await decideJevMove(new Chess().fen(), "balanced");
    expect(decision.telemetry.source).toBe("local-fallback");
    expect(decision.warning).toContain("合法候选");
  });
});
