import type { RemoteAgentId } from "../../../../../packages/contracts/src/remote-agent";

// Provision private native server config once. Never replace existing state.
export const openClawBootstrap = `
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const home = '/home/node/.openclaw';
await mkdir(home, { recursive: true, mode: 0o700 });
await mkdir(home + '/workspace', { recursive: true });
const config = {
  gateway: { mode: 'local', bind: 'lan', port: 18789,
    auth: { mode: 'token', token: '\${OPENCLAW_GATEWAY_TOKEN}' }, controlUi: { enabled: false } },
  desktop: { host: { enabled: true, managed: true } },
  plugins: { allow: ['browser', 'cua-computer'], entries: { 'cua-computer': { enabled: true }, browser: { enabled: true } } },
  agents: { defaults: { workspace: home + '/workspace', heartbeat: { every: '0m' } } },
  cron: { enabled: false }
};
try { await writeFile(home + '/openclaw.json', JSON.stringify(config), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
const child = spawn(process.execPath, ['/app/openclaw.mjs', 'gateway', '--bind', 'lan'], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
`;

export const remoteDeployments = {
  openhands: { name: "OpenHands", version: "1.53.0", commit: "54daf056bd863bb46f922a2fe9324dd736b37ff6", image: "selfme-lab/openhands-agent-server:1.53.0-source-54daf056bd86", port: 8000, mount: "/workspace", command: ["--host", "0.0.0.0"] },
  openclaw: { name: "OpenClaw", version: "2026.9.9", commit: "bcfc88812a35243893585dbeca87ca41b48272ca", image: "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35", port: 18789, mount: "/home/node/.openclaw", command: ["node", "--input-type=module", "-e", openClawBootstrap] },
} satisfies Record<RemoteAgentId, { name: string; version: string; commit: string; image: string; port: number; mount: string; command: string[] }>;

export function redactServiceOutput(value: string, secrets: string[] = []): string {
  let clean = value;
  for (const secret of secrets) if (secret) clean = clean.replaceAll(secret, "[已隐藏]");
  return clean.replace(/\bsk-[a-zA-Z0-9_-]{10,}/g, "[已隐藏]")
    .replace(/((?:"?(?:api[_ -]?key|authorization|token|password)"?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[已隐藏]");
}
