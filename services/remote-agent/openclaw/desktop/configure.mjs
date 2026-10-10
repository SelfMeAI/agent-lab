import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTerminalControl } from './session.mjs';
const assets = fileURLToPath(new URL('./', import.meta.url));
/** Configure only the disposable desktop shell, never native task/provider data. */
export async function configureDesktop(home = '/home/node') {
  if (home === '/home/node') await setTerminalControl();
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
}
