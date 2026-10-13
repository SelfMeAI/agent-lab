import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../../contracts/src/index";
import type { HarnessAdapter } from "./index";
import { CodexAdapter } from "./codex";
import { DshAdapter } from "./dsh";
import { KimiAdapter } from "./kimi";
import { QwenAdapter } from "./qwen";
import { PiAdapter } from "./pi";
import { chat, responses, prepareQwenTestHome, type Obj } from "./test-support/mock-model";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const runtimeRoot = process.env.AGENT_LAB_STEERING_RUNTIME_ROOT ?? join(root, "runtimes");
const nodeExecutable = process.env.AGENT_LAB_STEERING_NODE_EXECUTABLE ?? process.execPath;
const options = [{ label: "2048", description: "数字合并" }, { label: "扫雷", description: "推理" }];

describe("real harness human-question round trips (Pi uses Agent Lab's SDK custom tool)", () => {
  it.runIf(process.env.AGENT_LAB_STEERING_INTEGRATION === "1").each(["qwen-code", "kimi-code", "dsh", "codex", "pi"] as const)("%s actually receives answers and handles cancellation", async id => {
    await mkdir(join(root, ".work"), { recursive: true });
    const scratch = await mkdtemp(join(root, ".work/question-native-"));
    const workspace = join(scratch, "workspace"); await mkdir(workspace);
    const events: RunEvent[] = [], errors: string[] = [], requests: Obj[] = [];
    let receivedAnswers = false, receivedCustom = false, receivedCancellation = false, nextQuestion = true, turn = 1;
    const server = createServer(async (req, res) => {
      try {
        let raw = ""; for await (const chunk of req) raw += String(chunk);
        const body = JSON.parse(raw) as Obj; requests.push(body);
        const respond = req.url?.includes("responses") ? responses : chat;
        if (nextQuestion) {
          nextQuestion = false;
          const tools = body.tools.map((t: Obj) => t.function ?? t);
          const name = tools.find((t: Obj) => /^(ask_user_question|AskUserQuestion|request_user_input)$/.test(t.name))?.name;
          if (!name) throw new Error(`No native question tool for ${id}: ${tools.map((t: Obj) => t.name).join(", ")}`);
          const base = [{ header: "游戏类型", question: "想加哪个游戏？", options },
            { header: "平台", question: "支持哪些平台？", options: [{ label: "电脑", description: "桌面" }, { label: "手机", description: "移动" }] }];
          const questions = base.map((q, i) => ({ ...q, ...(id === "kimi-code" ? { multi_select: i === 1 }
            : id === "qwen-code" ? { multiSelect: i === 1 }
              : id === "dsh" || id === "pi" ? { id: i ? "platform" : "game", multi_select: i === 1 }
                : { id: "game" }) }));
          // Codex's native question interface is single-select.
          respond(res, { name, args: { questions: id === "codex" ? questions.slice(0, 1) : questions } });
        } else {
          const context = JSON.stringify((body.messages ?? body.input).filter((message: Obj) => message.role === "tool" || message.type === "function_call_output"));
          if (turn === 1) {
            receivedAnswers = context.includes("扫雷") && (id === "codex" || context.includes("电脑") && context.includes("手机"));
            if (context.includes("No valid answers were provided")) throw new Error("Native question lost its answers");
          }
          if (turn === 4) {
            receivedCustom = context.includes("CUSTOM_ANSWER_947") && (!["kimi-code", "pi"].includes(id) || context.includes("CUSTOM_PLATFORM_948"));
            if (id === "kimi-code" && context.includes("__agent_lab_kimi_other__")) throw new Error("Synthetic Other marker leaked into Kimi's tool result");
          }
          if (turn === 2 && id === "kimi-code") receivedCancellation = context.includes("User dismissed the question without answering.");
          if (turn === 2 && id === "pi") receivedCancellation = context.includes('\\"cancelled\\":true') || context.includes('"cancelled":true');
          respond(res, undefined, turn === 1 ? "已收到你的选择" : turn === 4 ? "已收到你的自定义答案" : "已尊重取消回答");
        }
      } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const provider = async () => ({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "deepseek-v4-flash", apiKey: "sk-local-question-check" });
    const homeDirectory = join(scratch, "home");
    let adapter: HarnessAdapter;
    if (id === "qwen-code") adapter = new QwenAdapter({ homeDirectory: prepareQwenTestHome(homeDirectory), provider, nodeExecutable, entryPoint: join(runtimeRoot, "qwen-code/node_modules/@qwen-code/qwen-code/cli-entry.js") });
    else if (id === "kimi-code") adapter = new KimiAdapter({ homeDirectory, provider, nodeExecutable, entryPoint: join(runtimeRoot, "kimi-code/node_modules/@moonshot-ai/kimi-code/dist/main.mjs"), steeringLoader: join(runtimeRoot, "kimi-code/steering-loader.mjs") });
    else if (id === "dsh") adapter = new DshAdapter({ homeDirectory, provider, nodeExecutable, entryPoint: join(runtimeRoot, "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"), steeringLoader: join(runtimeRoot, "dsh/steering-loader.mjs") });
    else if (id === "pi") adapter = new PiAdapter({ homeDirectory, provider });
    else adapter = new CodexAdapter({ homeDirectory, provider, executable: join(runtimeRoot, "codex/bin/codex") });
    adapter.onEvent(event => { events.push(event); if (event.kind === "error") errors.push(event.text ?? "Runtime error"); });
    async function question(after: number): Promise<RunEvent> {
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(events.slice(after).some(e => e.approval?.questions !== undefined), JSON.stringify({ turn, requests: requests.length, lastInput: JSON.stringify(requests.at(-1)?.input ?? []).slice(-1800), events: events.slice(after).map(e => ({ kind: e.kind, phase: e.phase, text: e.text?.slice(0, 300), title: e.title, approval: e.approval })) })).toBe(true); }, { timeout: 6000 });
      return events.slice(after).find(e => e.approval?.questions !== undefined)!;
    }
    async function end(after: number): Promise<void> {
      await vi.waitFor(() => { expect(errors).toEqual([]); expect(events.slice(after).some(e => e.phase === "ready")).toBe(true); }, { timeout: 12000 });
    }
    try {
      await adapter.start(workspace);
      if (id === "codex") {
        const config = await readFile(join(homeDirectory, "config.toml"), "utf8");
        expect(config).toMatch(/^suppress_unstable_features_warning = true$/m);
        expect(config.indexOf("suppress_unstable_features_warning")).toBeLessThan(config.indexOf("[features]"));
        expect(config).toMatch(/^default_mode_request_user_input = true$/m);
      }
      const first = events.length; await adapter.send("先问我选择什么游戏和支持哪些平台，再根据答案继续。不要操作文件。");
      const asked = (await question(first)).approval!;
      expect(asked.questions).toHaveLength(id === "codex" ? 1 : 2);
      if (id === "kimi-code" || id === "pi") expect(asked.questions!.every(q => q.allowCustom)).toBe(true);
      const submit = asked.options.find(o => o.kind.includes("allow"))!;
      await expect(adapter.respondApproval(asked.requestId, submit.optionId, {})).rejects.toThrow(/回答/);
      const answers = Object.fromEntries(asked.questions!.map((q, i) => [q.id, i === 0 ? ["扫雷"] : ["电脑", "手机"]]));
      await adapter.respondApproval(asked.requestId, submit.optionId, answers); await end(first);
      expect(receivedAnswers).toBe(true);
      await expect(adapter.respondApproval(asked.requestId, submit.optionId, answers)).rejects.toThrow(/失效/);
      {
        const customStart = events.length; nextQuestion = true; turn = 4; await adapter.send("再问我一次，我会填写自己的答案。");
        const custom = (await question(customStart)).approval!;
        const customAnswers = Object.fromEntries(custom.questions!.map((q, index) => [q.id, index === 0 ? ["CUSTOM_ANSWER_947"] : id === "kimi-code" || id === "pi" ? ["电脑", "CUSTOM_PLATFORM_948"] : ["电脑"]]));
        await adapter.respondApproval(custom.requestId, custom.options.find(o => o.kind.includes("allow"))!.optionId, customAnswers);
        await end(customStart); expect(receivedCustom).toBe(true);
      }
      const second = events.length; nextQuestion = true; turn = 2; await adapter.send("再问我一次，我会取消回答。");
      const cancelled = (await question(second)).approval!;
      await adapter.respondApproval(cancelled.requestId, cancelled.options.find(o => o.kind.includes("reject"))!.optionId);
      await end(second);
      if (id === "kimi-code" || id === "pi") expect(receivedCancellation).toBe(true);
      const third = events.length; nextQuestion = true; turn = 3; await adapter.send("再问我一次，测试停止整个任务。");
      const stopping = (await question(third)).approval!;
      await adapter.cancel(); await end(third);
      await expect(adapter.respondApproval(stopping.requestId, stopping.options[0].optionId, answers)).rejects.toThrow(/失效/);
      if (id === "codex") expect(events.some(event => event.title === "Codex 提示" && event.text?.startsWith("Under-development features enabled:"))).toBe(false);
    } finally {
      await adapter.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    }
  }, 45000);
});
