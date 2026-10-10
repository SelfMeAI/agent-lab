import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
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
export async function setTerminalControl(lease) {
  await mkdir(state, { recursive: true, mode: 0o700 });
  const temporary = controlPath + '.' + randomUUID() + '.next';
  await writeFile(temporary, JSON.stringify(lease ?? {}), { mode: 0o600 }); await rename(temporary, controlPath);
  let sessions;
  try { ({ stdout: sessions } = await run('tmux', [...tmuxArgv(), 'list-sessions', '-F', '#{session_name}'])); } catch { return; }
  for (const name of sessions.trim().split('\n').filter(name => /^selfme-[0-9a-f-]{36}$/.test(name))) await run('tmux', [...tmuxArgv(), 'set-option', '-t', name, '@selfme_control', lease?.ready && name === 'selfme-' + lease.task ? '1' : '0']);
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
  return identity;
}
const showing = new Map();
export async function showTerminal(task, automatic = false) {
  if (showing.has(task)) return showing.get(task);
  const pending = openTerminalWindow(task, automatic).finally(() => { if (showing.get(task) === pending) showing.delete(task); });
  showing.set(task, pending); return pending;
}
async function openTerminalWindow(task, automatic) {
  const identity = await prepareTerminal(task);
  const suffix = ' · ' + task.slice(0, 8);
  const { stdout } = await run('wmctrl', ['-l']).catch(error => {
    // Fresh Xfce sessions can have no EWMH client-list property until the first
    // window maps. That is an empty desktop, not a failed terminal connection.
    if (String(error.stderr).includes('Cannot get client list properties')) return { stdout: '' };
    throw error;
  });
  const window = stdout.split('\n').find(line => /(?:智能体执行|人工终端)/.test(line) && line.endsWith(suffix))?.split(/\s+/)[0];
  if (window) {
    const alive = async file => { try { await run('pgrep', ['-f', terminalViewPattern(task, file)]); return true; } catch { return false; } };
    if (await alive('agent-terminal.mjs') && await alive('terminal-attach.mjs')) { if (!automatic) await run('wmctrl', ['-ia', window]); return; }
    // A closed tab is a disposable attachment. Rebuild the two views without
    // killing the shared shell or re-running the agent command.
    await run('wmctrl', ['-ic', window]);
  }
  await new Promise((resolve, reject) => {
    // Fixed trusted paths + a validated UUID, no interpolated user commands.
    const child = spawn('xfce4-terminal', ['--disable-server', '--title', '智能体执行' + suffix, '--working-directory', identity.cwd, '--hide-menubar', '--hide-toolbar', '--geometry', '110x30', ...(automatic ? ['--minimize'] : []), '--command', process.execPath + ' /opt/selfme/desktop/agent-terminal.mjs ' + task, '--active-tab', '--tab', '--title', '人工终端' + suffix, '--command', terminalArgv(task, true).join(' ')], { detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export async function disposeTerminal(task) {
  const identity = terminalIdentity(task);
  try { const { stdout } = await run('wmctrl', ['-l']); for (const line of stdout.split('\n')) if (/(?:智能体执行|人工终端)/.test(line) && line.endsWith(' · ' + task.slice(0, 8))) await run('wmctrl', ['-ic', line.split(/\s+/)[0]]); }
  catch { /* The desktop may already have stopped. */ }
  try { await run('tmux', ['-S', socket, 'kill-session', '-t', identity.name]); }
  catch { /* Already closed, or container restarted. */ }
}
