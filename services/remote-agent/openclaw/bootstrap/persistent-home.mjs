import { constants } from 'node:fs';
import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only the owned service volume is writable during this offline preparation.
// A native HOME on the task filesystem lets GIO use its standard home Trash;
// no library patches, extra privileges or task/config migrations are needed.
export async function prepareDesktopHome(volume = '/home/node/.openclaw', template = '/home/node') {
  for (const relative of ['.selfme-desktop', '.selfme-desktop/home']) {
    const path = join(volume, relative);
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('桌面主目录必须是真实目录，不能是符号链接');
  }
  for (const name of ['.bashrc', '.profile', '.bash_logout']) {
    try { await copyFile(join(template, name), join(volume, '.selfme-desktop/home', name), constants.COPYFILE_EXCL); }
    catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await prepareDesktopHome();
