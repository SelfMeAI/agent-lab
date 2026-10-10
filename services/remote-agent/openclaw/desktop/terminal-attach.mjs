import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { checkedTask, controlPath, tmuxArgv } from './session.mjs';
const run = promisify(execFile), task = process.argv[2], desktop = process.argv[3] === 'desktop';
await checkedTask(task);
// Both entrances start read-only. Only the desktop attachment can unlock,
// after the Gateway has stopped native work and admitted a control lease.
const child = spawn('tmux', [...tmuxArgv(), 'attach-session', '-r', '-t', 'selfme-' + task], { stdio: 'inherit' });
let busy = false, writable = false;
async function checkAccess() {
  if (!desktop || busy || !child.pid) return; busy = true;
  try {
    let lease; try { lease = JSON.parse(await readFile(controlPath, 'utf8')); } catch {}
    const allowed = lease?.task === task && lease.ready === true && lease.expiresAt > Date.now();
    if (!allowed && !writable) return;
    const { stdout } = await run('tmux', [...tmuxArgv(), 'list-clients', '-F', '#{client_pid} #{client_tty} #{client_flags}']);
    const [, tty, flags] = stdout.split('\n').find(line => line.startsWith(child.pid + ' '))?.split(' ') ?? [];
    if (!tty) return;
    const readonly = flags.split(',').includes('read-only');
    // tmux 3.3a intentionally cannot clear read-only through refresh-client.
    // Its native switch-client -r toggles it. Query the actual client first,
    // so renewal or an immediate server-side revocation cannot invert the flag.
    if (allowed && readonly) await run('tmux', [...tmuxArgv(), 'switch-client', '-c', tty, '-t', 'selfme-' + task, '-r']);
    else if (!allowed && !readonly) await run('tmux', [...tmuxArgv(), 'refresh-client', '-t', tty, '-f', 'read-only']);
    writable = allowed;
  } catch { /* Fail closed: initial/readmitted attachments are read-only. */ }
  finally { busy = false; }
}
const timer = setInterval(() => void checkAccess(), 200);
child.once('exit', code => { clearInterval(timer); process.exit(code ?? 0); });
child.once('error', error => { console.error(error.message); clearInterval(timer); process.exit(1); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
