import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
const run = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const state = '/home/node/.cache/selfme-lab';
const socket = join(state, 'terminal.sock');
const config = '/opt/selfme/desktop/config/tmux.conf';
export const contextPath = join(state, 'desktop-context.json');
export const controlPath = join(state, 'terminal-control.json');
export function tmuxArgv() { return ['-S', socket, '-f', config]; }
export function terminalIdentity(task) {
  if (typeof task !== 'string' || !uuid.test(task)) throw new Error('任务标识无效');
  return { task, name: 'selfme-' + task, cwd: '/home/node/.openclaw/workspace/selfme/' + task };
}
export async function checkedTask(task) {
  const identity = terminalIdentity(task);
  if (await realpath(identity.cwd) !== identity.cwd || await readFile(join(identity.cwd, '.selfme-workspace'), 'utf8') !== task) throw new Error('任务工作区未准备好');
  return identity;
}
export async function setDesktopTask(task) {
  const identity = await checkedTask(task);
  await mkdir(state, { recursive: true, mode: 0o700 });
  // Only task identity is stored; never credentials or host paths.
  const next = contextPath + '.' + randomUUID() + '.next';
  await writeFile(next, JSON.stringify({ task }), { mode: 0o600 });
  await rename(next, contextPath);
  return identity;
}
export function terminalArgv(task, desktop = false) {
  terminalIdentity(task);
  return [process.execPath, '/opt/selfme/desktop/terminal-attach.mjs', task, desktop ? 'desktop' : 'observer'];
}
export function terminalViewPattern(task, file) {
  terminalIdentity(task);
  if (!['agent-terminal.mjs', 'terminal-attach.mjs'].includes(file)) throw new Error('终端视图无效');
  return '^' + process.execPath.replaceAll('.', '\\.') + ' /opt/selfme/desktop/' + file.replaceAll('.', '\\.') + ' ' + task + (file === 'terminal-attach.mjs' ? ' desktop' : '') + '$';
}
export function terminalWindowArgv(task, automatic = false) {
  const identity = terminalIdentity(task), suffix = ' · ' + task.slice(0, 8);
  // The narrowly scoped native terminal patch recognizes this marker and
  // disables focus_on_map before the first map, even without prior user input.
  // Later Dock clicks can still activate this normal, non-minimized window.
  return ['--disable-server', '--title', '智能体执行' + suffix, '--working-directory', identity.cwd, '--hide-menubar', '--hide-toolbar', '--geometry', '110x30', ...(automatic ? ['--startup-id=selfme-observer_TIME1'] : []), '--command', process.execPath + ' /opt/selfme/desktop/agent-terminal.mjs ' + task, '--active-tab', '--tab', '--title', '人工终端' + suffix, '--command', terminalArgv(task, true).join(' ')];
}
export async function setTerminalControl(lease) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const temporary = controlPath + '.' + randomUUID() + '.next';
  await writeFile(temporary, JSON.stringify(lease ?? {}), { mode: 0o600 }); await rename(temporary, controlPath);
  let sessions;
  try { ({ stdout: sessions } = await run('tmux', [...tmuxArgv(), 'list-sessions', '-F', '#{session_name}'])); } catch { return; }
  for (const name of sessions.trim().split('\n').filter(name => /^selfme-[0-9a-f-]{36}$/.test(name))) {
    await run('tmux', [...tmuxArgv(), 'set-option', '-t', name, '@selfme_control', lease?.ready && name === 'selfme-' + lease.task ? '1' : '0']);
    await run('tmux', [...tmuxArgv(), 'set-option', '-t', name, '@selfme_human_control', lease?.humanControl && name === 'selfme-' + lease.task ? '1' : '0']);
  }
  if (!lease?.ready) {
    // Revoke existing GUI clients immediately; no reconnect or lost shell.
    let stdout; try { ({ stdout } = await run('tmux', [...tmuxArgv(), 'list-clients', '-F', '#{client_tty}'])); } catch { return; }
    await Promise.all(stdout.trim().split('\n').filter(Boolean).map(tty => run('tmux', [...tmuxArgv(), 'refresh-client', '-t', tty, '-f', 'read-only'])));
  }
}
export async function inputTerminal(task, data, authorize = () => {}) {
  const identity = await checkedTask(task);
  // Native Gateway custody is checked before this operation. Hex keys preserve
  // UTF-8, newlines and Ctrl+C without interpreting pasted text as tmux commands.
  const bytes = Buffer.from(data, 'utf8');
  for (let offset = 0; offset < bytes.length; offset += 1024) { authorize(); await run('tmux', [...tmuxArgv(), 'send-keys', '-t', identity.name + ':0.0', '-H', ...Array.from(bytes.subarray(offset, offset + 1024), byte => byte.toString(16).padStart(2, '0'))]); }
}
export async function prepareTerminal(task) {
  const identity = await checkedTask(task);
  await mkdir(state, { recursive: true, mode: 0o700 });
  try { await run('tmux', ['-S', socket, 'has-session', '-t', identity.name]); }
  catch {
    try { await run('tmux', ['-S', socket, '-f', config, 'new-session', '-d', '-s', identity.name, '-c', identity.cwd, '/bin/bash', '--noprofile', '--norc']); }
    catch (error) { try { await run('tmux', ['-S', socket, 'has-session', '-t', identity.name]); } catch { throw error; } }
  }
  // A new shell may be created after the access file was last synchronized.
  let access; try { access = JSON.parse(await readFile(controlPath, 'utf8')); } catch {}
  await run('tmux', [...tmuxArgv(), 'set-option', '-t', identity.name, '@selfme_control', access?.task === task && access.ready && access.expiresAt > Date.now() ? '1' : '0']);
  await run('tmux', [...tmuxArgv(), 'set-option', '-t', identity.name, '@selfme_human_control', access?.task === task && access.humanControl && access.expiresAt > Date.now() ? '1' : '0']);
  return identity;
}
const showing = new Map();
async function terminalWindow(task) {
  const { stdout } = await run('wmctrl', ['-l']).catch(error => {
    // A newly prepared desktop may not have an EWMH client list yet.
    if (String(error.stderr).includes('Cannot get client list properties')) return { stdout: '' };
    throw error;
  });
  return stdout.split('\n').find(line => /(?:智能体执行|人工终端)/.test(line) && line.endsWith(' · ' + task.slice(0, 8)))?.split(/\s+/)[0];
}
export async function showTerminal(task, automatic = false, view) {
  if (showing.has(task)) {
    await showing.get(task);
    // A deliberate Dock click during automatic restoration still expresses
    // activation intent. Do not create a duplicate window or lose that click.
    if (!automatic || view) await selectTerminalView(task, view);
    return;
  }
  const pending = openTerminalWindow(task, automatic).then(() => view ? selectTerminalView(task, view) : undefined).finally(() => { if (showing.get(task) === pending) showing.delete(task); });
  showing.set(task, pending); return pending;
}
async function selectTerminalView(task, view) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const window = await terminalWindow(task);
    if (window) {
      const { stdout: windows } = await run('wmctrl', ['-l']);
      const title = windows.split('\n').find(line => line.startsWith(window + ' ')) ?? '';
      const { stdout: active } = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
      const activeId = active.match(/0x[0-9a-f]+/i)?.[0];
      const selected = view === 'agent' ? title.includes('智能体执行') : view === 'manual' ? title.includes('人工终端') : true;
      if (selected && activeId && Number.parseInt(activeId, 16) === Number.parseInt(window, 16)) return;
      // XSendEvent (--window) is ignored by GTK's tab accelerators. Activate
      // synchronously, then send a real XTEST key to this focused container
      // window; there is no change to the client's own view or focus.
      if (view) await run('xdotool', ['windowactivate', '--sync', window, 'key', '--clearmodifiers', view === 'agent' ? 'alt+1' : 'alt+2']);
      else await run('wmctrl', ['-ia', window]);
      return;
    }
    await wait(50);
  }
  throw new Error('终端窗口未能显示');
}
export async function showBrowser() {
  const { stdout } = await run('wmctrl', ['-lx']);
  const window = stdout.split('\n').find(line => /(?:chromium|google-chrome)\./i.test(line))?.split(/\s+/)[0];
  if (window) await run('wmctrl', ['-ia', window]);
}
async function openTerminalWindow(task, automatic) {
  await prepareTerminal(task);
  const window = await terminalWindow(task);
  if (window) {
    const alive = async file => { try { await run('pgrep', ['-f', terminalViewPattern(task, file)]); return true; } catch { return false; } };
    if (await alive('agent-terminal.mjs') && await alive('terminal-attach.mjs')) { if (!automatic) await run('wmctrl', ['-ia', window]); return; }
    // A closed tab is a disposable attachment. Rebuild the two views without
    // killing the shared shell or re-running the agent command.
    await run('wmctrl', ['-ic', window]);
  }
  await new Promise((resolve, reject) => {
    // Fixed trusted paths + a validated UUID, no interpolated user commands.
    const child = spawn('xfce4-terminal', terminalWindowArgv(task, automatic), { detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
  if (automatic) {
    // Raise this new observation window once so a maximized browser does not
    // hide it. XRaiseWindow changes stacking only, not keyboard focus; unlike
    // an "above" state it does not keep the terminal permanently on top.
    for (let attempt = 0; attempt < 40; attempt++) {
      const mapped = await terminalWindow(task);
      if (mapped) { await run('xdotool', ['windowraise', mapped]); return; }
      await wait(50);
    }
    throw new Error('智能体终端窗口未能显示');
  }
}
export async function disposeTerminal(task) {
  const identity = terminalIdentity(task);
  try { const { stdout } = await run('wmctrl', ['-l']); for (const line of stdout.split('\n')) if (/(?:智能体执行|人工终端)/.test(line) && line.endsWith(' · ' + task.slice(0, 8))) await run('wmctrl', ['-ic', line.split(/\s+/)[0]]); }
  catch { /* The desktop may already have stopped. */ }
  try { await run('tmux', ['-S', socket, 'kill-session', '-t', identity.name]); }
  catch { /* Already closed, or container restarted. */ }
}
