import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { RemoteServiceCredentials } from "./credentials";
import { RemoteAgentContainer } from "./service-manager";
import { remoteDeployments } from "./deployment";
import { RemoteModelClient } from "../../../../../packages/remote-agent/src/model-connection";
import { RemoteTaskController } from "./task-controller";
import { remoteTaskId } from "../../../../../packages/remote-agent/src/transport/http";
import type { RemoteTaskSnapshot, RemoteTerminalEvent } from "../../../../../packages/contracts/src/remote-agent";

// Explicit Docker integration; fixture-only connection keys, never real API calls.
describe.skipIf(process.env.SELFME_REMOTE_INTEGRATION !== "1")("native source-built remote services", () => {
  for (const engine of ["openhands", "openclaw"] as const) {
    it(`${engine}: authenticated start, native config persistence, restart and retained data`, async () => {
      const root = resolve(".work", "remote-agent", `integration-${engine}-${randomUUID()}`);
      const credentials = new RemoteServiceCredentials(root, {
        encrypt: async value => Buffer.from(value), decrypt: async value => value.toString(),
      }, engine);
      const container = new RemoteAgentContainer(root, () => credentials.get(), engine);
      const models = new RemoteModelClient(engine, () => container.requireEndpoint(), () => credentials.get());
      const connection = { endpoint: () => container.requireEndpoint(), credentials: () => credentials.get() };
      const terminalEvents: RemoteTerminalEvent[] = [];
      const taskUpdates = new Map<string, RemoteTaskSnapshot>();
      const tasks = new RemoteTaskController({ openhands: connection, openclaw: connection }, { choose: async () => [], save: async () => null }, update => taskUpdates.set(update.taskId, update.snapshot), event => terminalEvents.push(event));
      try {
        const state = await container.start();
        expect(state.phase).toBe("ready");
        expect(state.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const keys = await credentials.get();
        const saved = await models.save({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: `fixture-${randomUUID()}` });
        expect(saved.configured).toBe(true);
        // OpenClaw may hot-reload config.patch; wait on native readiness, no repeated write.
        await ready();
        expect(await models.get()).toMatchObject({ model: "deepseek-chat", baseUrl: "https://api.deepseek.com", configured: true });
        await models.save({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" });
        await ready();
        expect(await models.get()).toMatchObject({ model: "deepseek-flash", supportsImages: true });
        await models.save({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" });
        await ready();
        expect(await models.get()).toMatchObject({ model: "deepseek-v4-pro", supportsImages: false });
        const existingUnconfirmed = await models.save({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" });
        await ready();
        expect(existingUnconfirmed).not.toHaveProperty("supportsImages");
        expect((await models.get()).supportsImages).not.toBe(true);
        const unconfirmed = await models.save({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-reasoner" });
        await ready();
        expect(unconfirmed).not.toHaveProperty("supportsImages");
        // OpenClaw resolves absent input metadata using its catalog/text default;
        // that runtime default is not a confirmed provider capability in the UI.
        expect((await models.get()).supportsImages).not.toBe(true);
        await container.restart();
        expect(await models.get()).toMatchObject({ model: "deepseek-reasoner", configured: true });
        // A container-local fixture exercises the real authenticated lookup,
        // including both provider protocols, without hitting a paid model API.
        const execModels = promisify(execFile);
        await execModels("docker", ["exec", "--detach", container.name, "node", "--input-type=module", "-e", `
          import http from 'node:http';
          http.createServer((req,res) => {
            if (req.headers.authorization !== 'Bearer inventory-fixture' || !['/models','/v1/models'].includes(req.url)) { res.writeHead(401); res.end('private provider body'); return; }
            res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({data:[{id:'fixture-b'},{id:'fixture-a'},{id:'fixture-a'}]}));
          }).listen(8943,'127.0.0.1');
        `]);
        const priorConnection = await models.get();
        await expect.poll(() => models.listModels({ protocol: "openai", baseUrl: "http://127.0.0.1:8943", apiKey: "inventory-fixture" }), { timeout: 5000 }).toEqual(["fixture-a", "fixture-b"]);
        expect(await models.listModels({ protocol: "anthropic", baseUrl: "http://127.0.0.1:8943", apiKey: "inventory-fixture" })).toEqual(["fixture-a", "fixture-b"]);
        await expect(models.listModels({ protocol: "openai", baseUrl: "http://127.0.0.1:8943" })).rejects.toThrow("已更改");
        expect(await models.get()).toEqual(priorConnection);
        if (engine === "openhands") expect([401, 403]).toContain((await fetch(`${await container.requireEndpoint()}/api/selfme/models`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ protocol: "openai", baseUrl: "http://127.0.0.1:8943", apiKey: "inventory-fixture" }) })).status);
        const client = tasks.client(engine), task = await client.create();
        expect((await client.list()).some(row => row.id === task.id)).toBe(true);
        const files = client.http, body = new TextEncoder().encode("NATIVE_REMOTE_FILES_OK\n");
        expect((await files.upload(task.id, "uploads/proof.txt", body)).size).toBe(body.length);
        expect((await files.listFiles(task.id, "uploads")).files.map(row => row.name)).toEqual(["proof.txt"]);
        expect(await (await files.download(task.id, "uploads/proof.txt")).text()).toBe("NATIVE_REMOTE_FILES_OK\n");
        await expect(files.upload(task.id, "uploads/proof.txt", body)).rejects.toThrow("同名文件");
        const fileRoute = engine === "openhands" ? "/api/selfme/files" : "/selfme-lab/files";
        const query = new URLSearchParams({ task: remoteTaskId(task.id), path: "../private" });
        await expect(files.request(`${fileRoute}?${query}`)).rejects.toThrow("文件路径");
        expect([401, 403]).toContain((await fetch(`${await container.requireEndpoint()}${fileRoute}?task=${remoteTaskId(task.id)}&op=list`)).status);
        if (engine === "openhands") {
          const grant = await tasks.desktop(engine, task.id);
          expect(grant.control).toBe(false); expect(await framebufferHeader(grant.url)).toMatch(/^RFB /);
          await expect(framebufferHeader(grant.url)).rejects.toThrow();
        } else {
          const grant = await tasks.desktop(engine, task.id);
          expect(grant.control).toBe(true); expect(await framebufferHeader(grant.url)).toMatch(/^RFB /);
          await defaultDesktopReady(container.name);
          const scene = await tasks.claw.request<{ display: string }>("selfme.scene.prepare", { task: remoteTaskId(task.id) });
          expect(scene.display).toMatch(/^:\d+$/);
          const terminal = await tasks.claw.terminal(task.id);
          expect(terminal.cwd).toBe('/home/node/.openclaw/workspace/selfme/' + remoteTaskId(task.id));
          const windowState = () => desktopTerminalState(container.name, scene.display, remoteTaskId(task.id));
          expect((await windowState()).window).toBe(false);
          expect(await tasks.claw.terminalAccess(task.id)).toEqual({ busy: false, inputAllowed: true });
          await tasks.claw.terminalInput(task.id, terminal.id, "export SELFME_SHARED_SHELL=retained; printf '\\nIDLE_INPUT_OK\\n'\r");
          await expect.poll(() => stripVTControlCharacters(terminalEvents.map(event => event.data ?? "").join("")), { timeout: 5000 }).toMatch(/IDLE_INPUT_OK\r?\n/);
          expect((await windowState()).window).toBe(false);
          await tasks.claw.terminalInput(task.id, terminal.id, "sleep 2\r");
          await tasks.claw.terminalInput(task.id, terminal.id, "\x03");
          await tasks.claw.terminalInput(task.id, terminal.id, "\x1b[>0;276;0c");
          await expect(tasks.claw.request("selfme.terminal.input", { task: remoteTaskId(task.id), sessionId: "foreign-terminal", data: "echo BLOCKED\r" })).rejects.toThrow("不属于");
          const execDesktop = promisify(execFile);
          // Only an explicit desktop launcher opens the real shell window.
          await execDesktop("docker", ["exec", "-e", 'DISPLAY=' + scene.display, container.name, "node", "--input-type=module", "-e", "import { showTerminal } from '/opt/selfme/desktop/session.mjs'; await showTerminal(process.argv[1]);", remoteTaskId(task.id)]);
          await sharedTerminalOnDesktop(container.name, scene.display, remoteTaskId(task.id));
          await sharedTerminalAccess(container.name, remoteTaskId(task.id), 1);
          await tasks.claw.terminalInput(task.id, terminal.id, "printf '\\nREMOTE_PTY_OK\\n'; pwd; printenv DISPLAY\r");
          await expect.poll(() => stripVTControlCharacters(terminalEvents.map(event => event.data ?? "").join("")), { timeout: 10_000 }).toMatch(/REMOTE_PTY_OK\r?\n/);
          expect(terminalEvents.map(event => event.data ?? "").join("")).not.toContain("command not found");
          await expect.poll(() => terminalEvents.map(event => event.data ?? "").join(""), { timeout: 5000 }).toContain(scene.display);
          const serverPath = "uploads/scene-server.cjs";
          await files.upload(task.id, serverPath, new TextEncoder().encode("const http=require('node:http');http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><title>Remote scene proof</title><h1>REMOTE_SCENE_OK</h1>');}).listen(8734,'127.0.0.1',()=>console.log('REMOTE_SERVER_READY'));"));
          await tasks.claw.terminalInput(task.id, terminal.id, "node '" + terminal.cwd + "/" + serverPath + "'\r");
          await expect.poll(() => terminalEvents.map(event => event.data ?? "").join(""), { timeout: 5000 }).toContain("REMOTE_SERVER_READY");
          // Exercise the native browser API, not a replacement client browser.
          const browser = await tasks.claw.request<{ targetId: string }>("browser.request", { method: "POST", path: "/tabs/open", body: { url: "http://127.0.0.1:8734/" }, tabScope: { sessionKey: task.id } });
          await tasks.claw.request("browser.request", { method: "POST", path: "/tabs/focus", body: { targetId: browser.targetId }, tabScope: { sessionKey: task.id } });
          await browserOnDesktop(container.name, scene.display);
          await expect.poll(async () => (await windowState()).activeTitle, { timeout: 5000 }).toContain("Chromium");
          const focus = (await windowState()).active;
          await tasks.claw.terminalInput(task.id, terminal.id, "\x03");
          await tasks.claw.terminalInput(task.id, terminal.id, "printf '\\n%s\\n' \"$SELFME_SHARED_SHELL\"\r");
          await expect.poll(() => stripVTControlCharacters(terminalEvents.map(event => event.data ?? "").join("")), { timeout: 5000 }).toMatch(/retained\r?\n/);
          expect((await windowState()).active).toBe(focus);
          await tasks.claw.terminalClose(task.id, terminal.id);
          const reopened = await tasks.claw.terminal(task.id);
          await tasks.claw.terminalInput(task.id, reopened.id, "printf '\\nREATTACHED_%s\\n' \"$SELFME_SHARED_SHELL\"\r");
          await expect.poll(() => stripVTControlCharacters(terminalEvents.map(event => event.data ?? "").join("")), { timeout: 5000 }).toMatch(/REATTACHED_retained\r?\n/);
          expect((await windowState()).active).toBe(focus);
          // Closing the GUI attachment must not kill or reopen the shared shell.
          await execDesktop("docker", ["exec", "-e", 'DISPLAY=' + scene.display, container.name, "node", "--input-type=module", "-e", "import { execFileSync } from 'node:child_process';const id=process.argv[1];const row=execFileSync('wmctrl',['-l'],{encoding:'utf8'}).split('\\n').find(line=>line.endsWith('人工终端 · '+id.slice(0,8)));if(row)execFileSync('wmctrl',['-ic',row.split(/\\s+/)[0]]);", remoteTaskId(task.id)]);
          await expect.poll(async () => (await windowState()).window, { timeout: 5000 }).toBe(false);
          await tasks.claw.terminalInput(task.id, reopened.id, "printf '\\nAFTER_GUI_CLOSE_%s\\n' \"$SELFME_SHARED_SHELL\"\r");
          await expect.poll(() => stripVTControlCharacters(terminalEvents.map(event => event.data ?? "").join("")), { timeout: 5000 }).toMatch(/AFTER_GUI_CLOSE_retained\r?\n/);
          expect((await windowState()).window).toBe(false);
          await tasks.claw.terminalClose(task.id, reopened.id);
          // Real native command execution, live output and Stop, without paid API calls.
          await execDesktop("docker", ["exec", "--detach", container.name, "node", "--input-type=module", "-e", await readFile("scripts/remote-agent/fixtures/execution-provider.mjs", "utf8")]);
          const cfg = await tasks.claw.request<{ hash: string }>("config.get");
          await tasks.claw.request("config.patch", { baseHash: cfg.hash, raw: JSON.stringify({ models: { providers: { selfme: { baseUrl: "http://127.0.0.1:8944/v1", api: "openai-completions", apiKey: "execution-fixture", request: { allowPrivateNetwork: true }, models: [{ id: "execution-fixture", name: "Execution fixture", input: ["text"] }] } } }, agents: { defaults: { model: { primary: "selfme/execution-fixture" } } }, tools: { codeMode: false } }) });
          await ready();
          const native = await tasks.claw.create(); await tasks.claw.open(native.id);
          const snapshot = () => taskUpdates.get(native.id);
          const commandText = () => snapshot()?.items.filter(item => item.tool).map(item => item.tool!.output ?? "").join("\n") ?? "";
          await tasks.claw.send(native.id, "EXEC_TEST");
          await expect.poll(() => snapshot()?.items.find(item => item.approval)?.approval?.id, { timeout: 15_000 }).toBeTruthy();
          await tasks.claw.approve(native.id, snapshot()!.items.find(item => item.approval)!.approval!.id, "once");
          await expect.poll(commandText, { timeout: 10_000 }).toContain("NATIVE_EXEC_BEGIN");
          expect((await tasks.claw.terminalAccess(native.id)).busy).toBe(true);
          const during = await tasks.claw.desktop(native.id); expect(during.control).toBe(true);
          expect((await desktopTerminalState(container.name, scene.display, remoteTaskId(native.id))).window).toBe(false);
          await expect.poll(() => snapshot()?.task.status, { timeout: 20_000 }).toBe("completed");
          expect(commandText()).toContain("NATIVE_EXEC_END");
          expect((await desktopTerminalState(container.name, scene.display, remoteTaskId(native.id))).window).toBe(false);
          await tasks.claw.send(native.id, "STOP_TEST");
          await expect.poll(() => snapshot()?.items.find(item => item.approval)?.approval?.id, { timeout: 15_000 }).toBeTruthy();
          await tasks.claw.approve(native.id, snapshot()!.items.find(item => item.approval)!.approval!.id, "once");
          await expect.poll(commandText, { timeout: 10_000 }).toContain("NATIVE_STOP_BEGIN");
          await tasks.claw.control(native.id, "stop");
          await expect.poll(() => snapshot()?.task.status, { timeout: 10_000 }).toBe("paused");
          expect(commandText()).not.toContain("NATIVE_STOP_END");
          expect((await tasks.claw.terminalAccess(native.id)).inputAllowed).toBe(true);
          const processes = await execDesktop("docker", ["exec", container.name, "sh", "-lc", "pgrep -a -f '^sleep 60$' || true"]);
          expect(processes.stdout.trim()).toBe("");
          await tasks.claw.delete(native.id);
          await models.save({ protocol: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-reasoner", apiKey: "fixture-restored" });
          await ready();
        }
        tasks.reset();
        if (engine === "openclaw") {
          // Simulate an image-upgrade recreation with a retained Chromium
          // profile whose process lock still names the retired container.
          await container.stop();
          const exec = promisify(execFile);
          await exec("docker", ["rm", container.name]);
          await exec("docker", ["run", "--rm", "--network", "none", "--mount", `type=volume,src=${container.volume},dst=/home/node/.openclaw`, "--entrypoint", "node", remoteDeployments.openclaw.image, "--input-type=module", "-e", `
            import fs from 'node:fs/promises';
            const profile = '/home/node/.openclaw/browser/openclaw/user-data';
            for (const [name, target] of [['SingletonLock','retired-container-1234'],['SingletonSocket','/tmp/retired-browser/SingletonSocket'],['SingletonCookie','123456']]) {
              const path = profile + '/' + name;
              try { const info = await fs.lstat(path); if (!info.isSymbolicLink()) throw new Error('unexpected fixture marker'); await fs.unlink(path); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
              await fs.symlink(target, path);
            }
          `]);
          await container.start();
          expect((await exec("docker", ["inspect", "--format", "{{.Config.Hostname}}", container.name])).stdout.trim()).toBe(container.name);
        } else await container.restart();
        expect((await client.list()).some(row => row.id === task.id)).toBe(true);
        expect(await (await files.download(task.id, "uploads/proof.txt")).text()).toBe("NATIVE_REMOTE_FILES_OK\n");
        if (engine === "openclaw") {
          const grant = await tasks.desktop(engine, task.id);
          expect(await framebufferHeader(grant.url)).toMatch(/^RFB /);
          await defaultDesktopReady(container.name);
          const page = await tasks.claw.request<{ targetId: string }>("browser.request", { method: "POST", path: "/tabs/open", body: { url: "about:blank" }, tabScope: { sessionKey: task.id } });
          expect(page.targetId).toBeTruthy(); await browserOnDesktop(container.name, (await tasks.claw.request<{ display: string }>("selfme.scene.prepare", { task: remoteTaskId(task.id) })).display);
        }
        await client.delete(task.id); expect((await client.list()).some(row => row.id === task.id)).toBe(false);
        if (engine === "openhands") {
          const denied = await fetch(`${await container.requireEndpoint()}/api/settings`);
          expect([401, 403]).toContain(denied.status);
        }
        const logs = await container.logs();
        expect(logs).not.toContain(keys.sessionApiKey);
        expect(logs).not.toContain(keys.persistenceKey);
        expect((await container.stop()).phase).toBe("stopped");
        expect((await container.start()).phase).toBe("ready");
        expect((await models.get()).model).toBe("deepseek-reasoner");
      } catch (error) {
        console.error((await container.logs()).slice(-5000)); throw error;
      } finally {
        tasks.shutdown();
        // Only this test's unique, ownership-checked fixture is removed.
        await container.stop();
        const exec = promisify(execFile);
        await exec("docker", ["rm", container.name]);
        await exec("docker", ["volume", "rm", container.volume]);
        await rm(root, { recursive: true, force: true });
      }
      async function ready() {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if ((await container.state()).phase === "ready") return;
          await new Promise(resolve => setTimeout(resolve, 800));
        }
        throw new Error(`${engine} 保存设置后未恢复连接`);
      }
    }, 180_000);
  }
});

async function defaultDesktopReady(container: string): Promise<void> {
  const exec = promisify(execFile);
  await expect.poll(async () => {
    try {
      await exec("docker", ["exec", container, "sh", "-lc", "test -x /usr/bin/xfdesktop && test -x /usr/bin/thunar && test -x /usr/bin/xfce4-terminal && test -x /usr/bin/tmux && test -x /usr/bin/xdotool && test -e /opt/selfme/desktop/assets/galaxy.png && pgrep -x xfdesktop >/dev/null"]);
      return true;
    } catch { return false; }
  }, { timeout: 15_000 }).toBe(true);
}

async function sharedTerminalOnDesktop(container: string, display: string, task: string): Promise<void> {
  const exec = promisify(execFile);
  await expect.poll(async () => {
    const { stdout } = await exec("docker", ["exec", "-e", `DISPLAY=${display}`, container, "node", "--input-type=module", "-e", `
      import { execFileSync } from 'node:child_process';
      const task = process.argv[1], socket = '/home/node/.cache/selfme-lab/terminal.sock';
      const clients = execFileSync('tmux', ['-S', socket, 'list-clients', '-t', 'selfme-' + task, '-F', '#{client_tty}'], {encoding:'utf8'}).trim().split('\\n');
      const windows = execFileSync('wmctrl', ['-l'], {encoding:'utf8'});
      console.log(JSON.stringify({clients:clients.length, window:windows.includes('人工终端 · ' + task.slice(0,8))}));
    `, task]);
    return JSON.parse(stdout);
  }, { timeout: 10_000 }).toMatchObject({ clients: 2, window: true });
}

async function desktopTerminalState(container: string, display: string, task: string): Promise<{ window: boolean; visible: boolean; front: boolean; active: string; activeTitle: string }> {
  const exec = promisify(execFile);
  const { stdout } = await exec("docker", ["exec", "-e", `DISPLAY=${display}`, container, "node", "--input-type=module", "-e", `
    import { execFileSync } from 'node:child_process';
    const task = process.argv[1];
    let listing = ''; try { listing = execFileSync('wmctrl', ['-l'], {encoding:'utf8',stdio:['ignore','pipe','pipe']}); } catch (error) { if (!String(error.stderr).includes('Cannot get client list properties')) throw error; }
    const window = listing.split('\\n').find(line => /人工终端/.test(line) && line.endsWith(' · ' + task.slice(0,8)))?.split(/\\s+/)[0];
    const active = execFileSync('xprop', ['-root', '_NET_ACTIVE_WINDOW'], {encoding:'utf8'}).trim();
    const visible = !!window && /Map State: IsViewable/.test(execFileSync('xwininfo', ['-id', window], {encoding:'utf8'}));
    const activeId = active.match(/0x[0-9a-f]+/i)?.[0];
    const activeTitle = listing.split('\\n').find(line => activeId && parseInt(line.split(/\\s+/)[0],16) === parseInt(activeId,16)) ?? '';
    const normal = new Set(listing.split('\\n').filter(line => /^0x[0-9a-f]+\\s+0\\s/.test(line)).map(line => parseInt(line.split(/\\s+/)[0],16)));
    const stack = execFileSync('xprop', ['-root', '_NET_CLIENT_LIST_STACKING'], {encoding:'utf8'}).match(/0x[0-9a-f]+/gi) ?? [];
    const front = !!window && stack.map(id => parseInt(id,16)).filter(id => normal.has(id)).at(-1) === parseInt(window,16);
    console.log(JSON.stringify({window:!!window, visible, front, active, activeTitle}));
  `, task]);
  return JSON.parse(stdout);
}

async function sharedTerminalAccess(container: string, task: string, writable: number): Promise<void> {
  const exec = promisify(execFile);
  await expect.poll(async () => {
    const { stdout } = await exec("docker", ["exec", container, "tmux", "-S", "/home/node/.cache/selfme-lab/terminal.sock", "list-clients", "-t", "selfme-" + task, "-F", "#{client_flags}"]);
    return stdout.trim().split("\n").filter(Boolean).filter(flags => !flags.split(",").includes("read-only")).length;
  }, { timeout: 5000 }).toBe(writable);
}

async function browserOnDesktop(container: string, display: string): Promise<void> {
  const exec = promisify(execFile);
  const { stdout } = await exec("docker", ["exec", container, "node", "--input-type=module", "-e", `
    import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
    const display = process.argv[1];
    const browsers = fs.readdirSync('/proc').filter(pid => /^\\d+$/.test(pid)).flatMap(pid => {
      try {
        const command = fs.readFileSync('/proc/'+pid+'/cmdline','utf8').replaceAll(String.fromCharCode(0),' ');
        if (!command.startsWith('/usr/lib/chromium/chromium ') || command.includes(' --type=')) return [];
        return [{ headless:command.includes(' --headless') }];
      } catch { return []; }
    });
    const windows = execFileSync('xwininfo',['-root','-tree'],{env:{...process.env,DISPLAY:display},encoding:'utf8'});
    console.log(JSON.stringify({browsers,windowVisible:/Chromium/.test(windows)}));
  `, display]);
  const result = JSON.parse(stdout);
  // Chromium rewrites cmdline as a single process title. Verify both its launch
  // mode and a real window on the same display used by the task's native PTY.
  expect(result.browsers).toContainEqual({ headless: false });
  expect(result.windowVisible).toBe(true);
}

async function framebufferHeader(url: string): Promise<string> {
  const socket = new WebSocket(url, "binary"); socket.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("观察连接超时")), 10_000);
    let settled = false;
    const finish = (error?: Error, header?: string) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(header!); };
    socket.addEventListener("message", event => finish(undefined, new TextDecoder().decode(new Uint8Array(event.data as ArrayBuffer))));
    socket.addEventListener("error", () => finish(new Error("观察连接被拒绝")));
    socket.addEventListener("close", event => finish(new Error(`观察连接已关闭（${event.code}）${event.reason}`)));
  });
}
