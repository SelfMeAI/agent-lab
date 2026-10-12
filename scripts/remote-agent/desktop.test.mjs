import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configureDesktop } from '../../services/remote-agent/openclaw/desktop/configure.mjs';
import { terminalIdentity, terminalArgv, terminalWindowArgv, terminalViewPattern, tmuxArgv } from '../../services/remote-agent/openclaw/desktop/session.mjs';
import { simplifyPanelSource } from '../../services/remote-agent/openclaw/desktop/panel-menu.mjs';
const task = 'c0ec83da-66be-4f17-a2c2-01dc02c89f00';
test('terminal status has no normal-input banner and uses one native restriction notice', async () => {
  const config = await readFile('services/remote-agent/openclaw/desktop/config/tmux.conf', 'utf8');
  assert.match(config, /set -g status off/);
  assert.match(config, /selfme_terminal_notice/);
  assert.doesNotMatch(config, /可输入命令/);
  assert.doesNotMatch(config, /接管|selfme_human_control/);
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
  assert.deepEqual(terminalArgv(task), [process.execPath, '/opt/selfme/desktop/terminal-attach.mjs', task, 'external']);
  assert.deepEqual(terminalArgv(task, true), [process.execPath, '/opt/selfme/desktop/terminal-attach.mjs', task, 'desktop']);
  assert.deepEqual(tmuxArgv(), ['-S', '/home/node/.cache/selfme-lab/terminal.sock', '-f', '/opt/selfme/desktop/config/tmux.conf']);
  for (const value of ['', '../etc', task + '; whoami', task.toUpperCase(), null]) assert.throws(() => terminalIdentity(value));
});
test('the desktop terminal has one real shell attachment, not a projected agent tab', () => {
  const command = process.execPath + ' /opt/selfme/desktop/terminal-attach.mjs ' + task + ' desktop';
  const pattern = new RegExp(terminalViewPattern(task));
  assert.match(command, pattern);
  assert.doesNotMatch('xfce4-terminal --command ' + command, pattern);
  assert.doesNotMatch(command.replace(/ desktop$/, ' external'), pattern);
  const argv = terminalWindowArgv(task);
  assert.equal(argv.filter(value => value === '--command').length, 1);
  assert.ok(!argv.includes('--tab'));
  assert.ok(!argv.some(value => value.startsWith('--startup-id')));
  assert.throws(() => terminalWindowArgv(task + '; command'));
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
