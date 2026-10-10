import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configureDesktop } from '../../services/remote-agent/openclaw/desktop/configure.mjs';
import { terminalIdentity, terminalArgv, terminalWindowArgv, terminalViewPattern, tmuxArgv } from '../../services/remote-agent/openclaw/desktop/session.mjs';
import { ExecutionObserver, projectExecution, displayText, readExecution } from '../../services/remote-agent/openclaw/desktop/execution.mjs';
import { simplifyPanelSource } from '../../services/remote-agent/openclaw/desktop/panel-menu.mjs';
import { observerTerminalSource } from '../../services/remote-agent/openclaw/desktop/terminal-focus.mjs';
const task = 'c0ec83da-66be-4f17-a2c2-01dc02c89f00';
test('native terminal suppresses initial focus only for our automatic marker and refuses source drift', () => {
  const source = 'before\n      if (attr->startup_id != NULL)\n        gtk_window_set_startup_id (GTK_WINDOW (window), attr->startup_id);\nafter';
  const patched = observerTerminalSource(source);
  assert.match(patched, /if \(g_strcmp0 \(attr->startup_id, "selfme-observer_TIME1"\) == 0\)\n\s+gtk_window_set_focus_on_map \(GTK_WINDOW \(window\), FALSE\);\n\s+else if \(attr->startup_id != NULL\)/);
  assert.throws(() => observerTerminalSource('unexpected source'));
  assert.throws(() => observerTerminalSource(source + source));
  assert.throws(() => observerTerminalSource(patched));
});
test('native panel popup patch is narrow and refuses source drift', () => {
  const plugin = 'if (event->button == 3\n || (event->button == 1 && modifiers == GDK_CONTROL_MASK))\n {\n open_settings();\n }';
  const window = '\nstatic void\npanel_window_menu_popup (PanelWindow *window, GdkEventButton *event, gboolean game)\n{\n open_settings();\n}';
  assert.match(simplifyPanelSource(plugin, 'plugin'), /return TRUE;/);
  assert.match(simplifyPanelSource(window, 'window'), /return;/);
  assert.throws(() => simplifyPanelSource('different source', 'plugin'));
  assert.throws(() => simplifyPanelSource(plugin + plugin, 'plugin'));
  assert.throws(() => simplifyPanelSource(plugin, 'other'));
});
test('task terminal plan uses a private socket and strict identity, never interpolated user commands', () => {
  const identity = terminalIdentity(task);
  assert.equal(identity.cwd, '/home/node/.openclaw/workspace/selfme/' + task);
  assert.equal(identity.name, 'selfme-' + task);
  assert.deepEqual(terminalArgv(task), [process.execPath, '/opt/selfme/desktop/terminal-attach.mjs', task, 'observer']);
  assert.deepEqual(terminalArgv(task, true), [process.execPath, '/opt/selfme/desktop/terminal-attach.mjs', task, 'desktop']);
  assert.deepEqual(tmuxArgv(), ['-S', '/home/node/.cache/selfme-lab/terminal.sock', '-f', '/opt/selfme/desktop/config/tmux.conf']);
  for (const value of ['', '../etc', task + '; whoami', task.toUpperCase(), null]) assert.throws(() => terminalIdentity(value));
});
test('terminal view liveness matches the actual node process, not its launcher arguments', () => {
  for (const file of ['agent-terminal.mjs', 'terminal-attach.mjs']) {
    const command = process.execPath + ' /opt/selfme/desktop/' + file + ' ' + task + (file === 'terminal-attach.mjs' ? ' desktop' : '');
    const pattern = new RegExp(terminalViewPattern(task, file));
    assert.match(command, pattern);
    assert.doesNotMatch('xfce4-terminal --disable-server --command ' + command, pattern);
    assert.doesNotMatch('/bin/sh -c ' + command, pattern);
    assert.doesNotMatch(command + ' extra', pattern);
    if (file === 'terminal-attach.mjs') assert.doesNotMatch(command.replace(/ desktop$/, ' observer'), pattern);
  }
  assert.throws(() => terminalViewPattern(task, 'other.mjs'));
});
test('new rounds restore a visible observation window without asking the window manager for focus', () => {
  const automatic = terminalWindowArgv(task, true), manual = terminalWindowArgv(task);
  assert.ok(automatic.includes('--startup-id=selfme-observer_TIME1'));
  assert.ok(!automatic.includes('--minimize'));
  assert.ok(!manual.some(value => value.startsWith('--startup-id')));
  assert.equal(automatic.filter(value => value === '--command').length, 2);
  assert.throws(() => terminalWindowArgv(task + '; command', true));
});
test('curated desktop is reproducible and does not modify task/provider state', async () => {
  await mkdir('.work/remote-agent', { recursive: true });
  const fixture = await mkdtemp('.work/remote-agent/desktop-test-');
  try {
    await mkdir(join(fixture, '.openclaw'), { recursive: true });
    await writeFile(join(fixture, '.openclaw/openclaw.json'), 'retained-provider-state');
    await configureDesktop(fixture);
    const panel = await readFile(join(fixture, '.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml'), 'utf8');
    assert.match(panel, /value="tasklist"/);
    assert.doesNotMatch(panel, /applicationsmenu|systray|clock|actions|directorymenu|pager|showdesktop/);
    assert.equal((panel.match(/value="launcher"/g) ?? []).length, 3);
    assert.match(panel, /value="16"\/><value type="int" value="18"\/><value type="int" value="19"\/><value type="int" value="17"\/><value type="int" value="20"/);
    assert.equal((panel.match(/name="autohide-behavior" type="uint" value="0"/g) ?? []).length, 2);
    assert.equal((panel.match(/name="disable-struts" type="bool" value="false"/g) ?? []).length, 2);
    const desktop = await readFile(join(fixture, '.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml'), 'utf8');
    assert.match(desktop, /galaxy\.png/);
    assert.match(desktop, /name="desktop-menu"[^<]*<property name="show" type="bool" value="false"/);
    assert.match(desktop, /name="windowlist-menu"[^<]*<property name="show" type="bool" value="false"/);
    const manager = await readFile(join(fixture, '.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml'), 'utf8');
    assert.match(manager, /name="prevent_focus_stealing" type="bool" value="true"/);
    await configureDesktop(fixture);
    assert.equal(await readFile(join(fixture, '.openclaw/openclaw.json'), 'utf8'), 'retained-provider-state');
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
const event = (stream, data, runId = 'round-1') => ({ stream, data, runId, sessionKey: 'agent:main:selfme:' + task, ts: 1 });
test('agent terminal observes cumulative native output, background and approval states without re-executing', () => {
  let state = projectExecution(undefined, event('lifecycle', { phase: 'start' }));
  state = projectExecution(state, event('tool', { phase: 'start', name: 'exec', toolCallId: 'call', args: { command: 'printf hello' } }));
  state = projectExecution(state, event('lifecycle', { phase: 'waiting-approval', toolCallId: 'call' })); assert.equal(state.commands[0].status, 'waiting');
  state = projectExecution(state, event('lifecycle', { phase: 'approval-resolved', toolCallId: 'call' })); assert.equal(state.commands[0].status, 'running');
  state = projectExecution(state, event('command_output', { phase: 'delta', toolCallId: 'call', output: 'hello' }));
  state = projectExecution(state, event('command_output', { phase: 'delta', toolCallId: 'call', output: 'hello world' }));
  assert.equal(state.commands[0].input, 'printf hello'); assert.equal(state.commands[0].output, 'hello world');
  state = projectExecution(state, event('tool', { phase: 'result', name: 'exec', toolCallId: 'call', result: { details: { status: 'running', sessionId: 'native-process' } } }));
  state = projectExecution(state, event('command_output', { phase: 'end', toolCallId: 'call', status: 'completed' }));
  assert.equal(state.commands[0].status, 'background');
  state = projectExecution(state, event('approval', { phase: 'requested', toolCallId: 'approval', command: 'pwd', status: 'pending' }));
  assert.equal(state.commands[1].status, 'waiting');
  state = projectExecution(state, event('lifecycle', { phase: 'end' }));
  assert.equal(state.commands[0].status, 'background'); assert.equal(state.commands[1].status, 'interrupted');
  assert.equal(projectExecution(state, event('tool', { phase: 'update', name: 'exec', toolCallId: 'approval', partialResult: 'late' })), undefined);
  assert.equal(projectExecution(state, event('command_output', { toolCallId: 'call', output: 'old' }, 'old-run')), undefined);
  assert.equal(projectExecution(state, { ...event('lifecycle', { phase: 'start' }), sessionKey: 'another-agent' }), undefined);
  state = projectExecution(state, event('lifecycle', { phase: 'start' }, 'round-2')); assert.deepEqual(state.commands, []);
  assert.equal(displayText('\x1b]0;malicious-title\x07\x1b[31mred\x1b[0m\x00'), 'red');
});
test('native execution projection writes bounded atomic snapshots and opens once per round, not per command', async () => {
  await mkdir('.work/remote-agent', { recursive: true }); const directory = await mkdtemp('.work/remote-agent/execution-test-'); const opened = [], errors = [];
  const observer = new ExecutionObserver({ directory, onRound: task => opened.push(task), onError: error => errors.push(error) });
  try {
    observer.observe(event('lifecycle', { phase: 'start' })); observer.observe(event('lifecycle', { phase: 'start' }));
    for (let i = 0; i < 70; i++) observer.observe(event('tool', { phase: 'result', name: 'exec', toolCallId: 'call-' + i, args: { command: 'pwd' }, result: { content: [{ type: 'text', text: 'x'.repeat(80_000) }] } }));
    await observer.flush(task); const state = await readExecution(task, directory);
    assert.equal(state.commands.length, 64); assert.ok(state.commands.reduce((total, row) => total + row.output.length, 0) <= 512 * 1024); assert.deepEqual(opened, [task]);
    observer.observe(event('lifecycle', { phase: 'start' }, 'round-2')); await observer.flush(task); assert.equal((await readExecution(task, directory)).runId, 'round-2'); assert.deepEqual(opened, [task, task]);
    await observer.forget(task); observer.observe(event('tool', { phase: 'result', name: 'exec', toolCallId: 'late', result: { content: [{ text: 'late result' }] } }, 'round-2'));
    await observer.flush(task); assert.equal(await readExecution(task, directory), undefined); assert.deepEqual(errors, []);
  } finally { await observer.dispose(); await rm(directory, { recursive: true, force: true }); }
});
