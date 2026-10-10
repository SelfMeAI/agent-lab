import { checkedTask } from './session.mjs';
import { readExecution, displayText } from './execution.mjs';
const task = process.argv[2];
await checkedTask(task);
const states = { running: '执行中', completed: '已完成', failed: '失败', waiting: '等待授权', interrupted: '已停止', background: '后台运行' };
let revision, run, finished; const rendered = new Map();
const write = value => process.stdout.write(value.replace(/\n/g, '\r\n'));
write('\x1b[36m智能体执行 · 只读观察\x1b[0m\n命令由 OpenClaw 执行；关闭此页不会停止任务。\n切换到「人工终端」可使用共享 shell，输入前请在客户端接管。\n\n等待此任务的命令…\n');
// Consume stdin without forwarding it. Ctrl+C exits only this disposable viewer.
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', bytes => { if (bytes.includes(3)) process.exit(0); });
let reading = false;
async function refresh() {
  if (reading) return; reading = true;
  try {
    const snapshot = await readExecution(task);
    if (!snapshot || snapshot.revision === revision && snapshot.runId === run) return;
    revision = snapshot.revision;
    if (run !== snapshot.runId) {
      run = snapshot.runId; finished = false; rendered.clear();
      write('\n\x1b[36m──────────────── 新一轮任务 ────────────────\x1b[0m\n');
    }
    for (const command of snapshot.commands) {
      const old = rendered.get(command.id);
      if (!old) write('\n\x1b[36m$ ' + displayText(command.input || command.name) + '\x1b[0m\n');
      const output = displayText(command.output);
      if (output && output !== old?.output) {
        const delta = old?.output && output.startsWith(old.output) ? output.slice(old.output.length) : output;
        write(delta + (delta.endsWith('\n') ? '' : '\n'));
      }
      if (command.status !== old?.status) write('\x1b[' + (command.status === 'failed' ? '31' : command.status === 'completed' ? '32' : '90') + 'm[' + (states[command.status] ?? command.status) + (command.exitCode !== undefined ? ' · exit ' + command.exitCode : '') + ']\x1b[0m\n');
      rendered.set(command.id, { output, status: command.status });
    }
    if (snapshot.phase !== 'running' && !finished) { finished = true; write('\n\x1b[90m' + (snapshot.phase === 'failed' ? '本轮出错；可以从客户端继续。' : '本轮已结束。') + '\x1b[0m\n'); }
  } catch { /* Atomic snapshots may disappear during task deletion. Never retry execution. */ }
  finally { reading = false; }
}
await refresh(); setInterval(() => void refresh(), 250);
