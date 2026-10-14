import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile, rename } from 'node:fs/promises';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
const run = promisify(execFile);
// tmux/Xfce paths are always inside the Linux container, even in host-side tests.
const { join } = posix;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const state = '/home/node/.cache/agent-lab';
const socket = join(state, 'terminal.sock');
const config = '/opt/agent-lab/desktop/config/tmux.conf';
export const contextPath = join(state, 'desktop-context.json');
export const accessPath = join(state, 'terminal-access.json');
export function tmuxArgv() { return ['-S', socket, '-f', config]; }
export function terminalIdentity(task) {
  if (typeof task !== 'string' || !uuid.test(task)) throw new Error('任务标识无效');
  return { task, name: 'agent-lab-' + task, cwd: '/home/node/.openclaw/workspace/agent-lab/' + task };
}
export async function checkedTask(task) {
  const identity = terminalIdentity(task);
  if (await realpath(identity.cwd) !== identity.cwd || await readFile(join(identity.cwd, '.agent-lab-workspace'), 'utf8') !== task) throw new Error('任务工作区未准备好');
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
  return [process.execPath, '/opt/agent-lab/desktop/terminal-attach.mjs', task, desktop ? 'desktop' : 'external'];
}
export function terminalViewPattern(task) {
  terminalIdentity(task);
  return '^' + process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' /opt/agent-lab/desktop/terminal-attach\\.mjs ' + task + ' desktop$';
}
export function terminalWindowTitle(task) {
  terminalIdentity(task);
  return '终端 · ' + task.slice(0, 8);
}
export function terminalWindowArgv(task) {
  const identity = terminalIdentity(task);
  return ['--disable-server', '--title', terminalWindowTitle(task), '--working-directory', identity.cwd, '--hide-menubar', '--hide-toolbar', '--geometry', '110x30', '--command', terminalArgv(task, true).join(' ')];
}
async function setInputPresentation(name, access) {
  const current = name === 'agent-lab-' + access?.task;
  const synchronized = access?.expiresAt > Date.now();
  const writable = synchronized && current && access.ready === true;
  const notice = writable ? '' : !synchronized ? '终端输入状态暂不可用' : !current ? '请先在应用中选择此任务' : '智能体正在调用终端工具 · 暂不可输入';
  await run('tmux', [...tmuxArgv(), 'set-option', '-t', name, '@agent_lab_input', writable ? '1' : '0']);
  await run('tmux', [...tmuxArgv(), 'set-option', '-t', name, '@agent_lab_terminal_notice', notice]);
  await run('tmux', [...tmuxArgv(), 'set-option', '-t', name, 'status', writable ? 'off' : 'on']);
}
export async function setTerminalAccess(access) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const temporary = accessPath + '.' + randomUUID() + '.next';
  await writeFile(temporary, JSON.stringify(access ?? {}), { mode: 0o600 }); await rename(temporary, accessPath);
  let sessions;
  try { ({ stdout: sessions } = await run('tmux', [...tmuxArgv(), 'list-sessions', '-F', '#{session_name}'])); } catch { return; }
  for (const name of sessions.trim().split('\n').filter(name => /^agent-lab-[0-9a-f-]{36}$/.test(name))) {
    await setInputPresentation(name, access);
  }
  if (!access?.ready) {
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
  let access; try { access = JSON.parse(await readFile(accessPath, 'utf8')); } catch {}
  await setInputPresentation(identity.name, access);
  return identity;
}
const showing = new Map();
async function terminalWindow(task) {
  const { stdout } = await run('wmctrl', ['-l']).catch(error => {
    // A newly prepared desktop may not have an EWMH client list yet.
    if (String(error.stderr).includes('Cannot get client list properties')) return { stdout: '' };
    throw error;
  });
  return stdout.split('\n').find(line => line.endsWith(' ' + terminalWindowTitle(task)))?.split(/\s+/)[0];
}
/** Only an explicit desktop launcher opens or raises the terminal window. */
export async function showTerminal(task) {
  if (showing.has(task)) { await showing.get(task); return; }
  const pending = openTerminalWindow(task).finally(() => { if (showing.get(task) === pending) showing.delete(task); });
  showing.set(task, pending); return pending;
}
export async function showBrowser() {
  const { stdout } = await run('wmctrl', ['-lx']);
  const window = stdout.split('\n').find(line => /(?:chromium|google-chrome)\./i.test(line))?.split(/\s+/)[0];
  if (window) await run('wmctrl', ['-ia', window]);
}
async function openTerminalWindow(task) {
  await prepareTerminal(task);
  const window = await terminalWindow(task);
  if (window) {
    let alive = false; try { await run('pgrep', ['-f', terminalViewPattern(task)]); alive = true; } catch {}
    if (alive) { await run('wmctrl', ['-ia', window]); return; }
    await run('wmctrl', ['-ic', window]);
  }
  await new Promise((resolve, reject) => {
    // Fixed trusted paths and a validated UUID, never interpolated user commands.
    const child = spawn('xfce4-terminal', terminalWindowArgv(task), { detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    const mapped = await terminalWindow(task);
    if (mapped) { await run('wmctrl', ['-ia', mapped]); return; }
    await wait(50);
  }
  throw new Error('终端窗口未能打开');
}
export async function disposeTerminal(task) {
  const identity = terminalIdentity(task);
  try { const { stdout } = await run('wmctrl', ['-l']); for (const line of stdout.split('\n')) if (line.endsWith(' ' + terminalWindowTitle(task))) await run('wmctrl', ['-ic', line.split(/\s+/)[0]]); }
  catch { /* The desktop may already have stopped. */ }
  try { await run('tmux', ['-S', socket, 'kill-session', '-t', identity.name]); }
  catch { /* Already closed, or container restarted. */ }
}
