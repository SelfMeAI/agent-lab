import { mkdir } from "node:fs/promises";
import { AcpAdapter } from "./acp";

export interface KimiProvider {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface KimiAdapterOptions {
  executable: string;
  homeDirectory: string;
  provider(): Promise<KimiProvider>;
}

export class KimiAdapter extends AcpAdapter {
  constructor(options: KimiAdapterOptions) {
    super({
      id: "kimi-code",
      label: "Kimi Code",
      probePath: options.executable,
      readyDetail: "随应用安装的 Kimi Code ACP",
      missingDetail: "项目内 Kimi Code 运行时尚未安装",
      launch: async () => {
        const provider = await options.provider();
        await mkdir(options.homeDirectory, { recursive: true, mode: 0o700 });
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const name of Object.keys(env)) {
          if (name.startsWith("KIMI_MODEL_")) delete env[name];
        }
        env.KIMI_CODE_HOME = options.homeDirectory;
        env.KIMI_MODEL_PROVIDER_TYPE = "openai";
        env.KIMI_MODEL_BASE_URL = provider.baseUrl;
        env.KIMI_MODEL_NAME = provider.model;
        env.KIMI_MODEL_API_KEY = provider.apiKey;
        env.KIMI_DISABLE_TELEMETRY = "1";
        return { executable: options.executable, args: ["acp"], env, secret: provider.apiKey };
      },
    });
  }
}
