import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AcpAdapter } from "./acp";

export interface QwenProvider { apiKey: string; baseUrl: string; model: string }
export interface QwenAdapterOptions {
  entryPoint: string;
  nodeExecutable: string;
  homeDirectory: string;
  provider(): Promise<QwenProvider>;
}

/** Official, bundled Qwen Code CLI, using its native ACP and mid-turn input. */
export class QwenAdapter extends AcpAdapter {
  constructor(options: QwenAdapterOptions) {
    super({
      id: "qwen-code", label: "Qwen Code", probePath: options.entryPoint,
      readyDetail: "随应用安装的 Qwen Code ACP",
      missingDetail: "项目内 Qwen Code 运行时尚未安装",
      steeringDrainMethod: "craft/drainMidTurnQueue",
      closeSession: false,
      promptMeta: (text) => ({ "qwen.submittedPrompt": text }),
      launch: async () => {
        const provider = await options.provider();
        await mkdir(options.homeDirectory, { recursive: true, mode: 0o700 });
        const path = join(options.homeDirectory, "settings.json");
        let settings: Record<string, unknown> = {};
        try { settings = JSON.parse(await readFile(path, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        // Connection secrets only enter the child environment, never settings/argv.
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ ...settings,
          telemetry: { enabled: false },
          general: { ...(settings.general as Record<string, unknown> ?? {}), enableAutoUpdate: false },
          // This host has no suggestion widget; do not incur invisible model calls.
          ui: { ...(settings.ui as Record<string, unknown> ?? {}), enableFollowupSuggestions: false },
          security: { auth: { selectedType: "openai" } },
          model: { name: provider.model },
          modelProviders: { openai: [{ id: provider.model, envKey: "OPENAI_API_KEY", baseUrl: provider.baseUrl, wireApi: "chat-completions" }] },
        }), { mode: 0o600 });
        await rename(temporary, path);
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const name of ["QWEN_HOME", "QWEN_RUNTIME_DIR", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "QWEN_CODE_OAUTH_TOKEN"]) delete env[name];
        Object.assign(env, { QWEN_HOME: options.homeDirectory, QWEN_RUNTIME_DIR: options.homeDirectory,
          OPENAI_API_KEY: provider.apiKey, OPENAI_BASE_URL: provider.baseUrl,
          OPENAI_MODEL: provider.model, ELECTRON_RUN_AS_NODE: "1" });
        return { executable: options.nodeExecutable,
          args: [options.entryPoint, "--acp", "--auth-type", "openai", "--model", provider.model, "--approval-mode", "default", "--chat-recording"],
          env, secret: provider.apiKey };
      },
    });
  }
}
