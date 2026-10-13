import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Patch only panel chrome, not application menus or execution permissions.
 * Upstream 4.18 kiosk locks still expose logout/help and plugin menus.
 * Keep the two native popup handlers from opening those irrelevant entry points.
 * Fail the image build on source drift instead of silently applying a partial patch.
 */
export function simplifyPanelSource(source, kind) {
  if (!['plugin', 'window'].includes(kind)) throw new Error('Unknown panel source');
  const marker = kind === 'plugin'
    ? /(if \(event->button == 3\s*\|\| \(event->button == 1 && modifiers == GDK_CONTROL_MASK\)\)\s*\{)/g
    : /(\nstatic void\s+panel_window_menu_popup\s*\([^)]*\)\s*\{)/g;
  const matches = [...source.matchAll(marker)];
  if (matches.length !== 1) throw new Error(`Xfce panel ${kind} source has changed`);
  return source.replace(marker, `$1\n  /* Agent Lab: no desktop-shell settings menu. */\n  return${kind === 'plugin' ? ' TRUE' : ''};`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Xfce source directory is required');
  for (const [path, kind] of [['libxfce4panel/xfce-panel-plugin.c', 'plugin'], ['panel/panel-window.c', 'window']]) {
    const target = join(process.argv[2], path);
    await writeFile(target, simplifyPanelSource(await readFile(target, 'utf8'), kind));
  }
}
