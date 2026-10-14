import type { RemoteAgentId } from "../../../../../packages/contracts/src/remote-agent";
import { legacyResourceNamespace } from "../application-identity";

// Provision private native server config once. Never replace existing state.
export const openClawBootstrap = `
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { recoverManagedBrowserProfile } from '/opt/agent-lab/bootstrap/browser-profile.mjs';
import { configureDesktop } from '/opt/agent-lab/desktop/configure.mjs';
import { migrateOpenClawConfig, migrateOpenClawState } from '/opt/agent-lab/bootstrap/legacy-state.mjs';
process.env.LANG = 'C.UTF-8';
process.env.LC_ALL = 'C.UTF-8';
const home = '/home/node/.openclaw';
await migrateOpenClawState(home);
await configureDesktop();
await mkdir(home, { recursive: true, mode: 0o700 });
await mkdir(home + '/workspace', { recursive: true });
const recovered = await recoverManagedBrowserProfile(home, { privateVolume: process.env.AGENT_LAB_OPENCLAW_PRIVATE_VOLUME === '1' });
if (recovered.length) console.log('[agent-lab] Recovered stale managed browser process locks; profile data retained.');
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
const saved = migrateOpenClawConfig(JSON.parse(await readFile(home + '/openclaw.json', 'utf8')));
saved.plugins ??= {}; saved.plugins.entries ??= {}; saved.plugins.load ??= {};
saved.plugins.allow = [...new Set([...(saved.plugins.allow ?? []), 'agent-lab'])];
saved.plugins.load.paths = [...new Set([...(saved.plugins.load.paths ?? []), '/opt/agent-lab/plugin'])];
saved.plugins.entries['agent-lab'] = { ...(saved.plugins.entries['agent-lab'] ?? {}), enabled: true };
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
await writeFile(home + '/.agent-lab-config-next.json', JSON.stringify(saved), { mode: 0o600 });
await rename(home + '/.agent-lab-config-next.json', home + '/openclaw.json');
const child = spawn(process.execPath, ['/app/openclaw.mjs', 'gateway', '--bind', 'lan'], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));
`;

export const remoteDeployments = {
  openhands: { name: "OpenHands", version: "1.53.0", commit: "54daf056bd863bb46f922a2fe9324dd736b37ff6", image: "agent-lab/openhands-agent-server:1.53.0-source-54daf056bd86-lab10", legacyImages: ["agent-lab/openhands-agent-server:1.53.0-source-54daf056bd86", ...Array.from({ length: 9 }, (_, i) => `agent-lab/openhands-agent-server:1.53.0-source-54daf056bd86-lab${i + 1}`)], port: 8000, mount: "/workspace", command: [] },
  openclaw: { name: "OpenClaw", version: "2026.9.9", commit: "bcfc88812a35243893585dbeca87ca41b48272ca", image: "agent-lab/openclaw:2026.9.9-source-bcfc88812a35-lab32", legacyImages: ["agent-lab/openclaw:2026.9.9-source-bcfc88812a35", ...Array.from({ length: 31 }, (_, i) => `agent-lab/openclaw:2026.9.9-source-bcfc88812a35-lab${i + 1}`)], port: 18789, mount: "/home/node/.openclaw", command: ["node", "--input-type=module", "-e", openClawBootstrap] },
} satisfies Record<RemoteAgentId, { name: string; version: string; commit: string; image: string; legacyImages: string[]; port: number; mount: string; command: string[] }>;

// Recognize only the exact previously pinned images for a volume-preserving
// upgrade. New images, labels, APIs and configuration always use Agent Lab.
for (const deployment of Object.values(remoteDeployments)) {
  deployment.legacyImages.push(...[deployment.image, ...deployment.legacyImages].map(image => image.replace(/^agent-lab\//, `${legacyResourceNamespace}/`)));
}

export function redactServiceOutput(value: string, secrets: string[] = []): string {
  let clean = value;
  for (const secret of secrets) if (secret) clean = clean.replaceAll(secret, "[已隐藏]");
  return clean.replace(/\bsk-[a-zA-Z0-9_-]{10,}/g, "[已隐藏]")
    .replace(/((?:"?(?:api[_ -]?key|authorization|token|password)"?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[已隐藏]");
}
