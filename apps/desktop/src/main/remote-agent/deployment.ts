import type { RemoteAgentId } from "../../../../../packages/contracts/src/remote-agent";

// Provision private native server config once. Never replace existing state.
export const openClawBootstrap = `
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { recoverManagedBrowserProfile } from '/opt/selfme/bootstrap/browser-profile.mjs';
import { configureDesktop } from '/opt/selfme/desktop/configure.mjs';
process.env.LANG = 'C.UTF-8';
process.env.LC_ALL = 'C.UTF-8';
await configureDesktop();
const home = '/home/node/.openclaw';
await mkdir(home, { recursive: true, mode: 0o700 });
await mkdir(home + '/workspace', { recursive: true });
const recovered = await recoverManagedBrowserProfile(home, { privateVolume: process.env.SELFME_OPENCLAW_PRIVATE_VOLUME === '1' });
if (recovered.length) console.log('[selfme] Recovered stale managed browser process locks; profile data retained.');
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
// Deployment extension migration only; model accounts, task histories and
// device trust remain native and are never regenerated or reset.
const saved = JSON.parse(await readFile(home + '/openclaw.json', 'utf8'));
saved.plugins ??= {}; saved.plugins.entries ??= {}; saved.plugins.load ??= {};
saved.plugins.allow = [...new Set([...(saved.plugins.allow ?? []), 'selfme-lab'])];
saved.plugins.load.paths = [...new Set([...(saved.plugins.load.paths ?? []), '/opt/selfme/plugin'])];
saved.plugins.entries['selfme-lab'] = { ...(saved.plugins.entries['selfme-lab'] ?? {}), enabled: true };
saved.tools ??= {}; saved.tools.profile ??= 'full';
saved.tools.exec ??= { host: 'gateway', security: 'allowlist', ask: 'on-miss' };
saved.gateway ??= {}; saved.gateway.terminal ??= {}; saved.gateway.terminal.enabled = true;
// Managed Chromium is inside this private Docker container. Linux user
// namespaces are unavailable here; this is not a change to the user's browser.
saved.browser ??= {}; saved.browser.noSandbox ??= true;
// The integration prepares the native managed desktop before browser/exec
// operations. Use that same display, rather than a separate invisible browser.
saved.browser.headless = false;
saved.browser.extraArgs = [...new Set([...(saved.browser.extraArgs ?? []), '--start-maximized'])];
// The user authorized previewing apps inside this remote computer. Permit only
// its own loopback hosts, not the host machine, LAN or arbitrary private IPs.
saved.browser.ssrfPolicy ??= {};
saved.browser.ssrfPolicy.allowedHostnames = [...new Set([...(saved.browser.ssrfPolicy.allowedHostnames ?? []), 'localhost', '127.0.0.1'])];
await writeFile(home + '/.selfme-config-next.json', JSON.stringify(saved), { mode: 0o600 });
await rename(home + '/.selfme-config-next.json', home + '/openclaw.json');
const child = spawn(process.execPath, ['/app/openclaw.mjs', 'gateway', '--bind', 'lan'], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
`;

export const remoteDeployments = {
  openhands: { name: "OpenHands", version: "1.53.0", commit: "54daf056bd863bb46f922a2fe9324dd736b37ff6", image: "selfme-lab/openhands-agent-server:1.53.0-source-54daf056bd86-lab5", legacyImages: ["selfme-lab/openhands-agent-server:1.53.0-source-54daf056bd86", "selfme-lab/openhands-agent-server:1.53.0-source-54daf056bd86-lab1", "selfme-lab/openhands-agent-server:1.53.0-source-54daf056bd86-lab2", "selfme-lab/openhands-agent-server:1.53.0-source-54daf056bd86-lab3", "selfme-lab/openhands-agent-server:1.53.0-source-54daf056bd86-lab4"], port: 8000, mount: "/workspace", command: [] },
  openclaw: { name: "OpenClaw", version: "2026.9.9", commit: "bcfc88812a35243893585dbeca87ca41b48272ca", image: "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab11", legacyImages: ["selfme-lab/openclaw:2026.9.9-source-bcfc88812a35", "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab1", "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab2", "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab3", "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab4", "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab5", "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab6", "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab7", "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab8", "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab9", "selfme-lab/openclaw:2026.9.9-source-bcfc88812a35-lab10"], port: 18789, mount: "/home/node/.openclaw", command: ["node", "--input-type=module", "-e", openClawBootstrap] },
} satisfies Record<RemoteAgentId, { name: string; version: string; commit: string; image: string; legacyImages: string[]; port: number; mount: string; command: string[] }>;

export function redactServiceOutput(value: string, secrets: string[] = []): string {
  let clean = value;
  for (const secret of secrets) if (secret) clean = clean.replaceAll(secret, "[已隐藏]");
  return clean.replace(/\bsk-[a-zA-Z0-9_-]{10,}/g, "[已隐藏]")
    .replace(/((?:"?(?:api[_ -]?key|authorization|token|password)"?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[已隐藏]");
}
