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
export function terminalArgv(task) {
  return ['/usr/bin/tmux', '-S', socket, '-f', config, 'attach-session', '-t', terminalIdentity(task).name];
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
export async function showTerminal(task) {
  const identity = await prepareTerminal(task);
  const title = 'Terminal · ' + task.slice(0, 8);
  const { stdout } = await run('wmctrl', ['-l']);
  const window = stdout.split('\n').find(line => line.endsWith(title))?.split(/\s+/)[0];
  if (window) { await run('wmctrl', ['-ia', window]); return; }
  await new Promise((resolve, reject) => {
    // Fixed trusted paths + a validated UUID, no interpolated user commands.
    const child = spawn('xfce4-terminal', ['--disable-server', '--title', title, '--working-directory', identity.cwd, '--hide-menubar', '--hide-toolbar', '--geometry', '110x30', '--command', terminalArgv(task).join(' ')], { detached: true, stdio: 'ignore' });
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export async function disposeTerminal(task) {
  const identity = terminalIdentity(task);
  try { await run('tmux', ['-S', socket, 'kill-session', '-t', identity.name]); }
  catch { /* Already closed, or container restarted. */ }
}
