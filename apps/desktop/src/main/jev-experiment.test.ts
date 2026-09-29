import { afterEach, describe, expect, it, vi } from "vitest";
import { jevExperimentIds, jevExperiments } from "../jev-experiments/catalog";

vi.mock("./provider-store", () => ({ getJevProvider: vi.fn() }));

import { getJevProvider } from "./provider-store";
import { runJevExperiment } from "./jev-experiment";

const provider = vi.mocked(getJevProvider);

afterEach(() => {
  vi.unstubAllGlobals();
  provider.mockReset();
});

describe("JEV experiment boundary", () => {
  for (const experimentId of jevExperimentIds) {
    it(`sends only predefined actions for ${experimentId} and returns real typed measurements`, async () => {
      provider.mockResolvedValue({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "test-only-key" });
      const definition = jevExperiments[experimentId];
      const actionId = definition.actions[0].id;
      const fetchMock = vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({
          model: "jev-1.13.0",
          answers: {
            action: { choice: actionId, confidence: .74, probabilities: { [actionId]: .74 } },
            urgency: { score: 1.5, confidence: .8 },
            anomaly: { noul: .2 },
          },
          usage: { input_tokens: 140, output_tokens: 21 },
        }),
      }));
      vi.stubGlobal("fetch", fetchMock);
      const decision = await runJevExperiment(experimentId, definition.cases[0].state);
      expect(decision).toMatchObject({ experimentId, actionId, confidence: .74, urgencyScore: 1.5, anomalyProbability: .2, model: "jev-1.13.0", inputTokens: 140 });
      expect(decision.probabilities).toEqual({ [actionId]: .74 });
      const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(options.body as string);
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(body.state).toBe(definition.cases[0].state);
      expect(Object.keys(body.questions.action.criteria)).toEqual(definition.actions.map((action) => action.id));
      expect(Object.keys(body.questions)).toEqual(["action", "urgency", "anomaly"]);
    });
  }

  it("never fabricates missing measurements or a local decision", async () => {
    provider.mockResolvedValue({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "test-only-key" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ answers: { action: { choice: "AUTO_CLOSE", probabilities: {} } } }) })));
    const decision = await runJevExperiment("agent-review", jevExperiments["agent-review"].cases[0].state);
    expect(decision.actionId).toBe("AUTO_CLOSE");
    expect(decision.confidence).toBeNull();
    expect(decision.urgencyScore).toBeNull();
    expect(decision.anomalyProbability).toBeNull();
    expect(decision.probabilities).toEqual({});
    expect(decision.inputTokens).toBeNull();
  });

  it("rejects invalid choices and missing credentials instead of simulating an online result", async () => {
    provider.mockResolvedValue({ baseUrl: "https://api.typesafe.ai", model: "jev-latest", apiKey: "test-only-key" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ answers: { action: { choice: "PAY_NOW" } } }) })));
    await expect(runJevExperiment("invoice-routing", jevExperiments["invoice-routing"].cases[0].state)).rejects.toThrow("有效的预设动作");
    provider.mockResolvedValue({ baseUrl: "https://api.typesafe.ai", model: "jev-latest" });
    await expect(runJevExperiment("agent-review", jevExperiments["agent-review"].cases[0].state)).rejects.toThrow("API Key");
  });

  it("rejects arbitrary experiment ids and unsuitable input before a request", async () => {
    await expect(runJevExperiment("unknown" as "agent-review", "sample text long enough to test")).rejects.toThrow("未知");
    await expect(runJevExperiment("agent-review", "short")).rejects.toThrow("20–12000");
    expect(provider).not.toHaveBeenCalled();
  });
});
