import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { terminalIdentity } from './session.mjs';

export const executionDirectory = '/home/node/.cache/selfme-lab/execution';
const sessionPrefix = 'agent:main:selfme:';
const limit = 64 * 1024;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
// Native events have already undergone OpenClaw redaction. Strip terminal
// control sequences too: an observed command must not control the viewer.
export function displayText(value) {
  return typeof value === 'string' ? value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\r\n?/g, '\n').slice(-limit) : '';
}
function contentText(value) {
  if (typeof value === 'string') return displayText(value);
  if (Array.isArray(value)) return value.map(part => displayText(record(part).text)).filter(Boolean).join('\n');
  const item = record(value); return contentText(item.content ?? item.text ?? '');
}
export function executionPath(task, directory = executionDirectory) { terminalIdentity(task); return join(directory, task + '.json'); }

/** Projection only, never starts, repeats, interrupts, or owns a command. */
export function projectExecution(previous, event) {
  if (!event?.sessionKey?.startsWith(sessionPrefix)) return undefined;
  const task = event.sessionKey.slice(sessionPrefix.length);
  try { terminalIdentity(task); } catch { return undefined; }
  if (typeof event.runId !== 'string' || !event.runId) return undefined;
  const data = record(event.data), start = event.stream === 'lifecycle' && data.phase === 'start';
  if (previous && previous.runId !== event.runId && !start) return undefined;
  const state = !previous || previous.runId !== event.runId ? { schemaVersion: 1, task, runId: event.runId, phase: 'running', startedAt: event.ts, revision: 0, commands: [] } : structuredClone(previous);
  const terminal = event.stream === 'lifecycle' && ['end', 'error'].includes(data.phase);
  if (terminal) {
    state.phase = data.phase === 'error' ? 'failed' : 'finished'; state.endedAt = event.ts;
    for (const command of state.commands) if (['running', 'waiting'].includes(command.status)) command.status = 'interrupted';
  } else if (event.stream === 'lifecycle' && ['waiting-approval', 'approval-resolved'].includes(data.phase)) {
    const command = state.commands.find(row => row.id === data.toolCallId);
    if (command && ['running', 'waiting'].includes(command.status)) command.status = data.phase === 'waiting-approval' ? 'waiting' : 'running';
  } else if (event.stream === 'tool' || event.stream === 'command_output' || event.stream === 'approval') {
    const name = String(data.name ?? ''), id = data.toolCallId;
    if (typeof id !== 'string' || !id || (!['command_output', 'approval'].includes(event.stream) && !/^(exec|bash|process|shell|terminal|run_command)$/.test(name))) return undefined;
    let command = state.commands.find(row => row.id === id);
    if (!command) { command = { id, name: name || 'exec', input: '', output: '', status: 'running' }; state.commands.push(command); }
    const args = record(data.args), result = record(data.result ?? data.partialResult), details = record(result.details ?? data.details);
    command.input = displayText(args.command ?? data.command) || command.input || (name === 'process' ? [args.action, args.sessionId].filter(Boolean).join(' · ') : '');
    const output = displayText(data.output) || displayText(details.aggregated) || contentText(result);
    if (output) command.output = output; // Native partial output is cumulative, not an append delta.
    if (['completed', 'failed', 'interrupted'].includes(command.status) && ['start', 'update', 'delta'].includes(data.phase)) return undefined;
    if (event.stream === 'approval' || details.status === 'approval-pending') command.status = data.status === 'denied' || data.status === 'unavailable' ? 'failed' : data.status === 'approved' ? 'running' : 'waiting';
    else if (details.status === 'running' && details.sessionId) { command.status = 'background'; command.backgroundId = String(details.sessionId); }
    else if ((data.phase === 'result' || data.phase === 'end') && !(event.stream === 'command_output' && command.status === 'background' && data.status === 'completed')) command.status = data.isError || data.status === 'failed' || details.status === 'failed' ? 'failed' : 'completed';
    if (typeof data.exitCode === 'number' || typeof details.exitCode === 'number') command.exitCode = data.exitCode ?? details.exitCode;
    if (typeof data.durationMs === 'number' || typeof details.durationMs === 'number') command.durationMs = data.durationMs ?? details.durationMs;
    if (command.status !== 'background') delete command.backgroundId;
    state.commands = state.commands.slice(-64);
    let remaining = 512 * 1024;
    for (const row of state.commands.toReversed()) { row.output = remaining > 0 ? row.output.slice(-remaining) : ''; remaining -= row.output.length; }
  } else if (!start) return undefined;
  state.revision++; return state;
}

export class ExecutionObserver {
  states = new Map(); pending = new Map(); timers = new Map(); forgotten = new Set();
  constructor({ directory = executionDirectory, onRound = () => {}, onError = () => {} } = {}) { this.directory = directory; this.onRound = onRound; this.onError = onError; }
  observe(event) {
    const task = typeof event?.sessionKey === 'string' ? event.sessionKey.slice(sessionPrefix.length) : '';
    if (this.forgotten.has(task)) return;
    const previous = this.states.get(task), next = projectExecution(previous, event);
    if (!next) return;
    this.states.delete(task); this.states.set(task, next);
    // Bounded in-memory projection. Native transcripts remain the source of history.
    if (this.states.size > 128) this.states.delete(this.states.keys().next().value);
    if (!this.timers.has(task)) this.timers.set(task, setTimeout(() => { this.timers.delete(task); void this.flush(task); }, 100));
    if ((!previous || previous.runId !== next.runId) && event.stream === 'lifecycle' && event.data.phase === 'start') void Promise.resolve(this.onRound(task)).catch(this.onError);
  }
  async forget(task) {
    terminalIdentity(task); this.forgotten.add(task); if (this.forgotten.size > 128) this.forgotten.delete(this.forgotten.values().next().value);
    clearTimeout(this.timers.get(task)); this.timers.delete(task); this.states.delete(task);
    await this.pending.get(task); await unlink(executionPath(task, this.directory)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  flush(task) {
    const snapshot = this.states.get(task); if (!snapshot) return Promise.resolve();
    const pending = (this.pending.get(task) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = executionPath(task, this.directory), temporary = path + '.' + randomUUID() + '.next';
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 }); await rename(temporary, path);
    }).catch(this.onError).finally(() => { if (this.pending.get(task) === pending) this.pending.delete(task); });
    this.pending.set(task, pending); return pending;
  }
  async dispose() { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); await Promise.all([...this.states.keys()].map(task => this.flush(task))); this.states.clear(); }
}

export async function readExecution(task, directory = executionDirectory) {
  try { const value = JSON.parse(await readFile(executionPath(task, directory), 'utf8')); return value.schemaVersion === 1 && value.task === task && Array.isArray(value.commands) ? value : undefined; }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
