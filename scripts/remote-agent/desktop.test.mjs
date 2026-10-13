import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configureDesktop } from '../../services/remote-agent/openclaw/desktop/configure.mjs';
import { terminalIdentity, terminalArgv, terminalWindowArgv, terminalViewPattern, tmuxArgv } from '../../services/remote-agent/openclaw/desktop/session.mjs';
import { simplifyPanelSource } from '../../services/remote-agent/openclaw/desktop/panel-menu.mjs';
import { prepareDesktopHome } from '../../services/remote-agent/openclaw/bootstrap/persistent-home.mjs';
const task = 'c0ec83da-66be-4f17-a2c2-01dc02c89f00';
test('terminal status has no normal-input banner and uses one native restriction notice', async () => {
  const config = await readFile('services/remote-agent/openclaw/desktop/config/tmux.conf', 'utf8');
  assert.match(config, /set -g status off/);
  assert.match(config, /agent_lab_terminal_notice/);
  assert.doesNotMatch(config, /可输入命令/);
  assert.doesNotMatch(config, /接管|agent_lab_human_control/);
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
  assert.equal(identity.cwd, '/home/node/.openclaw/workspace/agent-lab/' + task);
  assert.equal(identity.name, 'agent-lab-' + task);
  assert.deepEqual(terminalArgv(task), [process.execPath, '/opt/agent-lab/desktop/terminal-attach.mjs', task, 'external']);
  assert.deepEqual(terminalArgv(task, true), [process.execPath, '/opt/agent-lab/desktop/terminal-attach.mjs', task, 'desktop']);
  assert.deepEqual(tmuxArgv(), ['-S', '/home/node/.cache/agent-lab/terminal.sock', '-f', '/opt/agent-lab/desktop/config/tmux.conf']);
  for (const value of ['', '../etc', task + '; whoami', task.toUpperCase(), null]) assert.throws(() => terminalIdentity(value));
});
test('the desktop terminal has one real shell attachment, not a projected agent tab', () => {
  const command = process.execPath + ' /opt/agent-lab/desktop/terminal-attach.mjs ' + task + ' desktop';
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
    const filesLauncher = await readFile(join(fixture, '.config/xfce4/panel/launcher-17/files.desktop'), 'utf8');
    assert.match(filesLauncher, /^Icon=folder$/m);
    assert.doesNotMatch(filesLauncher, /system-file-manager/);
    assert.match(filesLauncher, /^Exec=\/usr\/local\/bin\/node \/opt\/agent-lab\/desktop\/launch\.mjs files$/m);
    const desktop = await readFile(join(fixture, '.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml'), 'utf8');
    assert.match(desktop, /galaxy\.png/);
    assert.match(desktop, /name="style" type="int" value="2"/);
    assert.match(desktop, /name="show-trash" type="bool" value="true"/);
    for (const icon of ['show-home', 'show-filesystem', 'show-removable', 'show-network-removable', 'show-device-removable', 'show-unknown-removable']) assert.match(desktop, new RegExp(`name="${icon}" type="bool" value="false"`));
    assert.match(desktop, /name="desktop-menu"[^<]*<property name="show" type="bool" value="false"/);
    assert.match(desktop, /name="windowlist-menu"[^<]*<property name="show" type="bool" value="false"/);
    const manager = await readFile(join(fixture, '.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml'), 'utf8');
    assert.match(manager, /name="prevent_focus_stealing" type="bool" value="true"/);
    await configureDesktop(fixture);
    assert.equal(await readFile(join(fixture, '.openclaw/openclaw.json'), 'utf8'), 'retained-provider-state');
    const data = join(fixture, '.openclaw/.agent-lab-desktop/data/Trash');
    assert.equal((await stat(join(data, 'files'))).mode & 0o777, 0o700);
    await writeFile(join(data, 'files', 'retained.txt'), 'retained-trash-file');
    await writeFile(join(data, 'info', 'retained.txt.trashinfo'), 'retained-trash-metadata');
    await writeFile(join(fixture, '.config/user-dirs.dirs'), 'XDG_DOWNLOAD_DIR="$HOME/downloads"\nXDG_DESKTOP_DIR="$HOME/old-desktop"\n');
    await configureDesktop(fixture);
    assert.equal(await readFile(join(data, 'files', 'retained.txt'), 'utf8'), 'retained-trash-file');
    assert.equal(await readFile(join(data, 'info', 'retained.txt.trashinfo'), 'utf8'), 'retained-trash-metadata');
    const directories = await readFile(join(fixture, '.config/user-dirs.dirs'), 'utf8');
    assert.match(directories, /XDG_DOWNLOAD_DIR="\$HOME\/downloads"/);
    assert.match(directories, /XDG_DESKTOP_DIR="\$HOME\/\.openclaw\/\.agent-lab-desktop\/Desktop"/);
    assert.equal((directories.match(/XDG_DESKTOP_DIR=/g) ?? []).length, 1);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
test('desktop storage rejects a symlink before writing through it', async () => {
  await mkdir('.work/remote-agent', { recursive: true });
  const fixture = await mkdtemp('.work/remote-agent/desktop-link-test-');
  try {
    await mkdir(join(fixture, 'other'));
    await symlink('other', join(fixture, '.openclaw'));
    await assert.rejects(configureDesktop(fixture), /不能是符号链接/);
    await assert.rejects(stat(join(fixture, 'other', '.agent-lab-desktop')), { code: 'ENOENT' });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
test('persistent desktop home is private, additive and never follows a symlink', async () => {
  await mkdir('.work/remote-agent', { recursive: true });
  const fixture = await mkdtemp('.work/remote-agent/desktop-home-test-');
  try {
    const volume = join(fixture, 'volume'), template = join(fixture, 'template');
    await mkdir(volume); await mkdir(template);
    await writeFile(join(template, '.bashrc'), 'native-shell-template');
    await writeFile(join(volume, 'openclaw.json'), 'retained-provider-state');
    await prepareDesktopHome(volume, template);
    const home = join(volume, '.agent-lab-desktop/home');
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), 'native-shell-template');
    await writeFile(join(home, '.bashrc'), 'retained-user-shell');
    await prepareDesktopHome(volume, template);
    assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), 'retained-user-shell');
    assert.equal(await readFile(join(volume, 'openclaw.json'), 'utf8'), 'retained-provider-state');
    const linked = join(fixture, 'linked'); await mkdir(linked);
    await symlink('../template', join(linked, '.agent-lab-desktop'));
    await assert.rejects(prepareDesktopHome(linked, template), /不能是符号链接/);
    await assert.rejects(stat(join(template, 'home')), { code: 'ENOENT' });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
