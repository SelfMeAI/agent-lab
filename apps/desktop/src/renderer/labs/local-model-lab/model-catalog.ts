export interface LocalModelCatalogEntry {
  name: string;
  title: string;
  downloadBytes: number;
  note: string;
  availability: "ollama" | "import-required";
}

export interface LocalModelCatalogGroup {
  id: string;
  title: string;
  description: string;
  sources: readonly string[];
  models: readonly LocalModelCatalogEntry[];
}

// Curated download suggestions, not installed-model data or a compatibility
// certification. Sizes refer to the selected release/quantization, not RAM.
export const localModelCatalogCheckedAt = "2026-09-30";
export const localModelCatalog: readonly LocalModelCatalogGroup[] = [
  {
    id: "qwen", title: "Qwen", description: "中文通用 · 两代小规格对照",
    sources: ["https://ollama.com/library/qwen3/tags", "https://ollama.com/library/qwen3.5/tags"],
    models: [
      { name: "qwen3:0.6b", title: "Qwen3 · 0.6B", downloadBytes: 523_000_000, note: "轻量文本 · 支持思考输出", availability: "ollama" },
      { name: "qwen3.5:0.8b", title: "Qwen3.5 · 0.8B", downloadBytes: 1_000_000_000, note: "新一代小规格 · 本轮仅使用文本输入", availability: "ollama" },
      { name: "qwen3:1.7b", title: "Qwen3 · 1.7B", downloadBytes: 1_400_000_000, note: "文本模型 · 中间规格对照", availability: "ollama" },
      { name: "qwen3.5:2b-q4_K_M", title: "Qwen3.5 · 2B", downloadBytes: 1_900_000_000, note: "Q4_K_M 量化 · 本轮仅使用文本输入", availability: "ollama" },
      { name: "qwen3:4b-instruct", title: "Qwen3 · 4B Instruct", downloadBytes: 2_500_000_000, note: "非思考版 · 文本指令对照", availability: "ollama" },
      { name: "qwen3.5:4b", title: "Qwen3.5 · 4B", downloadBytes: 3_400_000_000, note: "更大一档 · 本轮仅使用文本输入", availability: "ollama" },
    ],
  },
  {
    id: "gemma", title: "Gemma", description: "Google · 从超小到多模态小规格",
    sources: ["https://ollama.com/library/gemma3/tags"],
    models: [
      { name: "gemma3:270m", title: "Gemma3 · 270M", downloadBytes: 292_000_000, note: "超小文本基准 · 通用能力有限", availability: "ollama" },
      { name: "gemma3:1b", title: "Gemma3 · 1B", downloadBytes: 815_000_000, note: "轻量文本 · 基础对照", availability: "ollama" },
      { name: "gemma3:4b", title: "Gemma3 · 4B", downloadBytes: 3_300_000_000, note: "更完整一档 · 本轮仅使用文本输入", availability: "ollama" },
    ],
  },
  {
    id: "granite", title: "Granite", description: "IBM · 摘要、抽取与业务文档实验",
    sources: ["https://ollama.com/library/granite4/tags", "https://ollama.com/library/granite4.2/tags"],
    models: [
      { name: "granite4:350m-h", title: "Granite4 · 350M Hybrid", downloadBytes: 366_000_000, note: "超小混合架构 · 指令任务基准", availability: "ollama" },
      { name: "granite4:1b-h", title: "Granite4 · 1B Hybrid", downloadBytes: 1_600_000_000, note: "混合架构 · 轻量业务任务对照", availability: "ollama" },
      { name: "granite4.2:3b", title: "Granite4.2 · 3B", downloadBytes: 2_200_000_000, note: "新一代 · 文档与结构化输出实验", availability: "ollama" },
    ],
  },
  {
    id: "liquid", title: "Liquid", description: "端侧小模型 · 思考与专项规格",
    sources: [
      "https://ollama.com/library/lfm2.5-thinking/tags",
      "https://huggingface.co/LiquidAI/LFM2.5-350M-GGUF",
      "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
      "https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF",
    ],
    models: [
      { name: "LiquidAI/LFM2.5-350M-GGUF:Q4_0", title: "LFM2.5 · 350M", downloadBytes: 219_000_000, note: "专项微调与实验 · 非通用聊天主力", availability: "import-required" },
      { name: "lfm2.5-thinking:1.2b", title: "LFM2.5 · 1.2B Thinking", downloadBytes: 731_000_000, note: "端侧思考版 · 轻量文本实验", availability: "ollama" },
      { name: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M", title: "LFM2.5 · 1.2B Instruct", downloadBytes: 731_000_000, note: "指令版 · 与 Thinking 版对照", availability: "import-required" },
      { name: "LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M", title: "LFM2.5 · 2.6B", downloadBytes: 1_670_000_000, note: "更大一档 · 端侧指令任务实验", availability: "import-required" },
    ],
  },
  {
    id: "phi", title: "Phi", description: "Microsoft · 小模型推理对照",
    sources: ["https://ollama.com/library/phi4-mini/tags"],
    models: [
      { name: "phi4-mini:3.8b", title: "Phi-4-mini · 3.8B", downloadBytes: 2_500_000_000, note: "数学、逻辑与结构化任务实验", availability: "ollama" },
    ],
  },
  {
    id: "mistral", title: "Mistral", description: "多语言 · Ministral 3 最小规格",
    sources: ["https://ollama.com/library/ministral-3/tags"],
    models: [
      { name: "ministral-3:3b", title: "Ministral 3 · 3B", downloadBytes: 3_000_000_000, note: "多语言指令 · 本轮仅使用文本输入", availability: "ollama" },
    ],
  },
  {
    id: "smollm", title: "SmolLM2", description: "Hugging Face · 英文超小实验基准",
    sources: ["https://ollama.com/library/smollm2/tags"],
    models: [
      { name: "smollm2:135m-instruct-q4_K_M", title: "SmolLM2 · 135M", downloadBytes: 105_000_000, note: "超小指令基准 · 通用能力有限", availability: "ollama" },
      { name: "smollm2:360m-instruct-q4_K_M", title: "SmolLM2 · 360M", downloadBytes: 271_000_000, note: "轻量英文指令 · 非中文主力", availability: "ollama" },
      { name: "smollm2:1.7b-instruct-q4_K_M", title: "SmolLM2 · 1.7B", downloadBytes: 1_100_000_000, note: "英文文本 · 更大规格对照", availability: "ollama" },
    ],
  },
];
