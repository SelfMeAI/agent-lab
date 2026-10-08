import { describe, expect, it } from "vitest";
import { validLocalModelName } from "../../../../../../packages/runtime/src/ollama";
import { localModelCatalog, localModelCatalogCheckedAt } from "./model-catalog";

describe("curated small-model download catalog", () => {
  it("keeps both existing starting models and exposes only verified registry names as downloadable", () => {
    const models = localModelCatalog.flatMap((group) => group.models);
    const downloadable = models.filter((model) => model.availability === "ollama");
    expect(downloadable.map((model) => model.name)).toContain("qwen3:0.6b");
    expect(downloadable.map((model) => model.name)).toContain("gemma3:1b");
    expect(downloadable).toHaveLength(18);
    for (const model of downloadable) {
      expect(validLocalModelName(model.name), model.name).toBe(true);
      expect(model.name).toContain(":");
      expect(model.name).not.toContain("latest");
      expect(model.downloadBytes).toBeLessThanOrEqual(3_400_000_000);
    }
  });

  it("groups unique candidates by series, orders them by download size and retains source provenance", () => {
    expect(localModelCatalogCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(new Set(localModelCatalog.map((group) => group.id)).size).toBe(localModelCatalog.length);
    const names = localModelCatalog.flatMap((group) => group.models.map((model) => model.name));
    expect(new Set(names).size).toBe(names.length);
    for (const group of localModelCatalog) {
      expect(group.title).toBeTruthy(); expect(group.description).toBeTruthy();
      expect(group.sources.length).toBeGreaterThan(0);
      for (const source of group.sources) expect(new URL(source).protocol).toBe("https:");
      const sizes = group.models.map((model) => model.downloadBytes);
      expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
      for (const model of group.models) {
        expect(model.downloadBytes).toBeGreaterThan(0);
        expect(model.title).toBeTruthy(); expect(model.note).toBeTruthy();
      }
    }
  });

  it("uses documented Hugging Face registry names, not invented native Ollama tags", () => {
    const gguf = localModelCatalog.flatMap((group) => group.models).filter((model) => model.availability === "huggingface");
    expect(gguf).toHaveLength(3);
    expect(gguf.every((model) => validLocalModelName(model.name) && model.name.startsWith("hf.co/LiquidAI/") && model.name.includes("GGUF:"))).toBe(true);
    expect(gguf.find((model) => model.title === "LFM2.5 · 350M")?.note).toContain("非通用聊天主力");
    expect(localModelCatalog.find((group) => group.id === "liquid")?.models.find((model) => model.availability === "ollama")?.name).toBe("lfm2.5-thinking:1.2b");
  });
});
