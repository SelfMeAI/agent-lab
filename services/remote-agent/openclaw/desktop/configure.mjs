import { mkdir, copyFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTerminalAccess } from './session.mjs';
const assets = fileURLToPath(new URL('./', import.meta.url));
/** Native desktop setup. Trash/desktop files persist; task/provider data is untouched. */
export async function configureDesktop(home = '/home/node') {
  home = await realpath(home);
  if (home === '/home/node') await setTerminalAccess();
  // Standard GIO Trash on the SAME persistent filesystem as the task files.
  // No custom delete interception, metadata rewriting, or automatic emptying.
  for (const relative of ['.openclaw', '.openclaw/.agent-lab-desktop', '.openclaw/.agent-lab-desktop/data', '.openclaw/.agent-lab-desktop/data/Trash', '.openclaw/.agent-lab-desktop/data/Trash/files', '.openclaw/.agent-lab-desktop/data/Trash/info', '.openclaw/.agent-lab-desktop/Desktop']) {
    const directory = join(home, relative);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('桌面数据目录必须是真实目录，不能是符号链接');
  }
  const config = join(home, '.config/xfce4');
  const channels = join(config, 'xfconf/xfce-perchannel-xml');
  await mkdir(channels, { recursive: true });
  for (const name of ['xfce4-panel', 'xfce4-desktop', 'xfwm4']) await copyFile(join(assets, 'config', name + '.xml'), join(channels, name + '.xml'));
  for (const [id, app] of [[17, 'files'], [18, 'browser'], [19, 'terminal']]) {
    const directory = join(config, 'panel', `launcher-${id}`);
    await mkdir(directory, { recursive: true });
    await copyFile(join(assets, 'launchers', app + '.desktop'), join(directory, app + '.desktop'));
  }
  await mkdir(join(config, 'terminal'), { recursive: true });
  await copyFile(join(assets, 'config', 'terminalrc'), join(config, 'terminal', 'terminalrc'));
  await writeFile(join(config, 'helpers.rc'), 'WebBrowser=chromium\nTerminalEmulator=xfce4-terminal\nWebBrowserDismissed=true\nTerminalEmulatorDismissed=true\n');
  // Give xfdesktop an actual Desktop directory, not its HOME fallback. Preserve
  // other user-directory settings and any files already in the previous folder.
  const directoriesFile = join(home, '.config', 'user-dirs.dirs');
  let directories = '';
  try { directories = await readFile(directoriesFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const desktopEntry = 'XDG_DESKTOP_DIR="$HOME/.openclaw/.agent-lab-desktop/Desktop"';
  directories = /^XDG_DESKTOP_DIR=.*$/m.test(directories) ? directories.replace(/^XDG_DESKTOP_DIR=.*$/m, desktopEntry) : directories + (directories && !directories.endsWith('\n') ? '\n' : '') + desktopEntry + '\n';
  await writeFile(directoriesFile, directories, { mode: 0o600 });
}
