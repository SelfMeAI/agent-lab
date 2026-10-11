import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { RemoteServiceCredentials } from "./credentials";
import { RemoteAgentContainer } from "./service-manager";
import { remoteDeployments } from "./deployment";
import { RemoteModelClient } from "../../../../../packages/remote-agent/src/model-connection";
import { RemoteTaskController } from "./task-controller";
import { remoteTaskId } from "../../../../../packages/remote-agent/src/transport/http";
import type { RemoteTerminalEvent } from "../../../../../packages/contracts/src/remote-agent";

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
      const tasks = new RemoteTaskController({ openhands: connection, openclaw: connection }, { choose: async () => [], save: async () => null }, () => {}, event => terminalEvents.push(event));
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
          const grant = await tasks.desktop(engine, task.id, false);
          expect(grant.control).toBe(false); expect(await framebufferHeader(grant.url)).toMatch(/^RFB /);
          await expect(framebufferHeader(grant.url)).rejects.toThrow();
        } else {
          const grant = await tasks.desktop(engine, task.id, false);
          expect(await framebufferHeader(grant.url)).toMatch(/^RFB /);
          await defaultDesktopReady(container.name);
          const scene = await tasks.claw.request<{ display: string }>("selfme.scene.prepare", { task: remoteTaskId(task.id) });
          expect(scene.display).toMatch(/^:\d+$/);
          const terminal = await tasks.claw.terminal(task.id);
          expect(terminal.cwd).toBe(`/home/node/.openclaw/workspace/selfme/${remoteTaskId(task.id)}`);
          // Opening the external terminal is an attachment, never a GUI launch.
          expect((await desktopTerminalState(container.name, scene.display, remoteTaskId(task.id))).window).toBe(false);
          expect(await tasks.claw.browserTabs(task.id)).toEqual([]);
          await expect(tasks.claw.browser(task.id)).rejects.toThrow("没有打开浏览器页面");
          await tasks.claw.request("selfme.terminal.prepare", { task: remoteTaskId(task.id) });
          await sharedTerminalOnDesktop(container.name, scene.display, remoteTaskId(task.id));
          await sharedTerminalAccess(container.name, remoteTaskId(task.id), 1);
          expect(await tasks.claw.sceneAccess(task.id)).toEqual({ agentBusy: false, humanControl: false, inputAllowed: true });
          await tasks.claw.terminalInput(task.id, terminal.id, "printf '\\nIDLE_INPUT_OK\\n'\r");
          await expect.poll(() => stripVTControlCharacters(terminalEvents.map(event => event.data ?? "").join("")), { timeout: 5000 }).toMatch(/IDLE_INPUT_OK\r?\n/);
          await tasks.claw.terminalInput(task.id, terminal.id, "sleep 2\r");
          await expect(tasks.claw.send(task.id, "must not reach provider while manual foreground work runs")).rejects.toThrow("人工终端仍在执行");
          expect(await tasks.claw.sceneAccess(task.id)).toMatchObject({ agentBusy: false, humanControl: false, inputAllowed: true });
          await tasks.claw.terminalInput(task.id, terminal.id, "\x03");
          await tasks.claw.terminalInput(task.id, terminal.id, "\x1b[>0;276;0c");
          await expect(tasks.claw.request("selfme.terminal.input", { task: remoteTaskId(task.id), sessionId: "foreign-terminal", data: "echo BLOCKED\r" })).rejects.toThrow("不属于");
          await tasks.claw.desktop(task.id, true);
          await sharedTerminalAccess(container.name, remoteTaskId(task.id), 1);
          await tasks.claw.terminalInput(task.id, terminal.id, "\x1b[>0;276;0c");
          await tasks.claw.terminalInput(task.id, terminal.id, "printf '\\nREMOTE_PTY_OK\\n'; pwd; printenv DISPLAY\r");
          // tmux may position the cursor instead of emitting a preceding LF,
          // and append erase-to-end-of-line before the next actual newline.
          // The trailing real newline still distinguishes output from the
          // echoed command's literal backslash-n marker.
          await expect.poll(() => stripVTControlCharacters(terminalEvents.map(event => event.data ?? "").join("")), { timeout: 15_000 }).toMatch(/REMOTE_PTY_OK\r?\n/);
          expect(terminalEvents.map(event => event.data ?? "").join("")).not.toContain("command not found");
          await expect.poll(() => terminalEvents.map(event => event.data ?? "").join(""), { timeout: 5000 }).toContain(scene.display);
          const serverPath = `uploads/scene-server.cjs`;
          await files.upload(task.id, serverPath, new TextEncoder().encode(`const http = require('node:http'); http.createServer((req,res) => { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); res.end('<!doctype html><title>Remote scene proof</title><body style="min-height:2800px"><h1>REMOTE_SCENE_OK</h1><button id="count" style="position:absolute;left:20px;top:80px;width:200px;height:50px" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><textarea id="input" aria-label="Input proof" style="position:absolute;left:20px;top:150px;width:300px;height:60px"></textarea>'); }).listen(8734,'127.0.0.1',()=>console.log('REMOTE_SERVER_READY'));`));
          await tasks.claw.terminalInput(task.id, terminal.id, `node '${terminal.cwd}/${serverPath}'\r`);
          await expect.poll(() => terminalEvents.map(event => event.data ?? "").join(""), { timeout: 5000 }).toContain("REMOTE_SERVER_READY");
          await tasks.claw.release();
          await sharedTerminalAccess(container.name, remoteTaskId(task.id), 1);
          expect(await tasks.claw.sceneAccess(task.id)).toMatchObject({ humanControl: false, inputAllowed: true });
          await tasks.claw.desktop(task.id, true);
          const browser = await tasks.claw.browser(task.id, { url: "about:blank" });
          expect(browser.pageUrl).toBe("about:blank"); expect(browser.tabs.some(tab => tab.targetId === browser.targetId)).toBe(true);
          expect(await browserFrameLength(browser.url)).toBeGreaterThan(100);
          await tasks.claw.focusBrowser(task.id, browser.targetId);
          await browserOnDesktop(container.name, scene.display);
          const localPage = await tasks.claw.browser(task.id, { url: "http://127.0.0.1:8734/" });
          expect(localPage.pageUrl).toBe("http://127.0.0.1:8734/");
          expect(await browserFrameLength(localPage.url)).toBeGreaterThan(100);
          expect((await tasks.claw.browserTabs(task.id)).find(tab => tab.targetId === localPage.targetId)?.title).toBe("Remote scene proof");
          const click = (x: number, y: number) => tasks.claw.browserInput(task.id, localPage.targetId, [{ kind: "mouse", type: "down", button: "left", buttons: 1, x, y }, { kind: "mouse", type: "up", button: "left", buttons: 0, x, y }]);
          await click(40, 100); await click(40, 170);
          await tasks.claw.browserInput(task.id, localPage.targetId, [{ kind: "text", text: "中文输入验收" }, { kind: "key", type: "down", key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 }, { kind: "key", type: "up", key: "Enter", code: "Enter", keyCode: 13, modifiers: 0 }]);
          const pageState = () => tasks.claw.request<{ result?: { count?: string; text?: string; scroll?: number } }>("browser.request", { method: "POST", path: "/act", body: { kind: "evaluate", targetId: localPage.targetId, fn: "() => ({count:document.getElementById('count').textContent,text:document.getElementById('input').value,scroll:window.scrollY})" }, tabScope: { sessionKey: task.id } });
          await expect.poll(pageState, { timeout: 5000 }).toMatchObject({ result: { count: "1", text: "中文输入验收\n" } });
          await tasks.claw.browserInput(task.id, localPage.targetId, [{ kind: "mouse", type: "wheel", x: 700, y: 400, deltaY: 300 }]);
          await expect.poll(async () => (await pageState()).result?.scroll, { timeout: 5000 }).toBeGreaterThan(0);
          await expect(tasks.claw.browserInput(task.id, "unowned", [{ kind: "text", text: "BLOCKED" }])).rejects.toThrow("不属于");
          await tasks.claw.release();
          await tasks.claw.request("selfme.browser.input", { task: remoteTaskId(task.id), targetId: localPage.targetId, events: [{ kind: "release" }], tabScope: { sessionKey: task.id } });
          // Handback restores observation, without closing Chrome or reopening a page.
          expect(await browserFrameLength((await tasks.claw.browser(task.id)).url)).toBeGreaterThan(100);
          await tasks.claw.focusBrowser(task.id, localPage.targetId);
          const backgroundTask = await tasks.claw.create();
          await tasks.claw.request("selfme.scene.prepare", { task: remoteTaskId(backgroundTask.id) });
          await expect.poll(async () => (await desktopTerminalState(container.name, scene.display, remoteTaskId(backgroundTask.id))).activeTitle, { timeout: 5000 }).toContain("Chromium");
          const focusBefore = (await desktopTerminalState(container.name, scene.display, remoteTaskId(backgroundTask.id))).active;
          const execWindow = promisify(execFile);
          await execWindow("docker", ["exec", "-e", `DISPLAY=${scene.display}`, container.name, "node", "--input-type=module", "-e", "import { showTerminal } from '/opt/selfme/desktop/session.mjs'; await showTerminal(process.argv[1], true);", remoteTaskId(backgroundTask.id)]);
          await expect.poll(() => desktopTerminalState(container.name, scene.display, remoteTaskId(backgroundTask.id)), { timeout: 10_000 }).toMatchObject({ window: true, visible: true, front: true, active: focusBefore });
          // A deliberate Dock-style open still activates the window. Updating
          // that existing window on another round must not activate or raise it.
          await tasks.claw.request("selfme.terminal.prepare", { task: remoteTaskId(backgroundTask.id) });
          await expect.poll(async () => (await desktopTerminalState(container.name, scene.display, remoteTaskId(backgroundTask.id))).activeTitle, { timeout: 5000 }).toContain(" · " + remoteTaskId(backgroundTask.id).slice(0, 8));
          await tasks.claw.focusBrowser(task.id, localPage.targetId);
          await expect.poll(async () => (await desktopTerminalState(container.name, scene.display, remoteTaskId(backgroundTask.id))).active, { timeout: 5000 }).toBe(focusBefore);
          await execWindow("docker", ["exec", "-e", `DISPLAY=${scene.display}`, container.name, "node", "--input-type=module", "-e", "import { showTerminal } from '/opt/selfme/desktop/session.mjs'; await showTerminal(process.argv[1], true);", remoteTaskId(backgroundTask.id)]);
          expect(await desktopTerminalState(container.name, scene.display, remoteTaskId(backgroundTask.id))).toMatchObject({ window: true, visible: true, front: false, active: focusBefore });
          // Actual agent commands, unlike passive observation, select and
          // foreground their native output tab. Real manual input selects the
          // other tab in the same task window; clients never jump views.
          await execWindow("docker", ["exec", "-e", `DISPLAY=${scene.display}`, container.name, "node", "--input-type=module", "-e", "import { showTerminal } from '/opt/selfme/desktop/session.mjs'; await showTerminal(process.argv[1], true, 'agent');", remoteTaskId(backgroundTask.id)]);
          await expect.poll(async () => (await desktopTerminalState(container.name, scene.display, remoteTaskId(backgroundTask.id))).activeTitle, { timeout: 5000 }).toContain("智能体执行 · " + remoteTaskId(backgroundTask.id).slice(0, 8));
          await tasks.claw.terminalInput(task.id, terminal.id, "\x03");
          await expect.poll(async () => (await desktopTerminalState(container.name, scene.display, remoteTaskId(task.id))).activeTitle, { timeout: 5000 }).toContain("人工终端 · " + remoteTaskId(task.id).slice(0, 8));
          await tasks.claw.delete(backgroundTask.id);
          await tasks.claw.desktop(task.id, true);
          await tasks.claw.terminalClose(task.id, terminal.id);
          const reopened = await tasks.claw.terminal(task.id);
          await tasks.claw.terminalInput(task.id, reopened.id, "printf '\\nREATTACHED_SHELL_OK\\n'\r");
          await expect.poll(() => stripVTControlCharacters(terminalEvents.map(event => event.data ?? "").join("")), { timeout: 5000 }).toMatch(/REATTACHED_SHELL_OK\r?\n/);
          await sharedTerminalOnDesktop(container.name, scene.display, remoteTaskId(task.id));
          await tasks.claw.terminalClose(task.id, reopened.id);
          await tasks.claw.release();
          await expect(tasks.claw.browser(task.id, { targetId: "unowned" })).rejects.toThrow("不属于");
          await expect(tasks.claw.focusBrowser(task.id, "unowned")).rejects.toThrow("不属于");
          const lease = await tasks.claw.request<{ id: string }>("selfme.control.acquire", { task: remoteTaskId(task.id) });
          await expect(tasks.claw.request("selfme.control.acquire", { task: remoteTaskId(task.id) })).rejects.toThrow("已有接管者");
          await tasks.claw.request("selfme.control.release", { id: lease.id });
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
          const grant = await tasks.desktop(engine, task.id, false);
          expect(await framebufferHeader(grant.url)).toMatch(/^RFB /);
          await defaultDesktopReady(container.name);
          await tasks.claw.desktop(task.id, true);
          const browser = await tasks.claw.browser(task.id, { url: "about:blank" });
          expect(await browserFrameLength(browser.url)).toBeGreaterThan(100);
          await tasks.claw.release();
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
      const observer = execFileSync('pgrep', ['-f', '^.*node /opt/selfme/desktop/agent-terminal.mjs ' + task + '$'], {encoding:'utf8'});
      console.log(JSON.stringify({clients:clients.length, window:windows.includes(' · ' + task.slice(0,8)), observer:!!observer.trim()}));
    `, task]);
    return JSON.parse(stdout);
  }, { timeout: 10_000 }).toMatchObject({ clients: 2, window: true, observer: true });
}

async function desktopTerminalState(container: string, display: string, task: string): Promise<{ window: boolean; visible: boolean; front: boolean; active: string; activeTitle: string }> {
  const exec = promisify(execFile);
  const { stdout } = await exec("docker", ["exec", "-e", `DISPLAY=${display}`, container, "node", "--input-type=module", "-e", `
    import { execFileSync } from 'node:child_process';
    const task = process.argv[1];
    let listing = ''; try { listing = execFileSync('wmctrl', ['-l'], {encoding:'utf8',stdio:['ignore','pipe','pipe']}); } catch (error) { if (!String(error.stderr).includes('Cannot get client list properties')) throw error; }
    const window = listing.split('\\n').find(line => /(?:智能体执行|人工终端)/.test(line) && line.endsWith(' · ' + task.slice(0,8)))?.split(/\\s+/)[0];
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

async function browserFrameLength(url: string): Promise<number> {
  const socket = new WebSocket(url); socket.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("浏览器没有传回实际画面")), 20_000); let settled = false;
    const finish = (error?: Error, size?: number) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(size!); };
    socket.addEventListener("message", event => { if (typeof event.data !== "string") finish(undefined, (event.data as ArrayBuffer).byteLength); });
    socket.addEventListener("error", () => finish(new Error("浏览器画面连接失败")));
    socket.addEventListener("close", () => finish(new Error("浏览器画面连接已关闭")));
  });
}
