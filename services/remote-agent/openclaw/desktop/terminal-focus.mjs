import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Only our automatic observer launch suppresses GTK's initial focus request. */
export function observerTerminalSource(source) {
  const marker = '      if (attr->startup_id != NULL)\n        gtk_window_set_startup_id (GTK_WINDOW (window), attr->startup_id);';
  if (source.split(marker).length !== 2 || source.includes('SelfMe Lab: observer window')) throw new Error('Xfce terminal focus source has changed');
  // A timestamp-bearing startup ID overrides GTK's no-focus-on-map user time.
  // Consume our marker here, rather than forwarding it as a real startup ID.
  return source.replace(marker, '      /* SelfMe Lab: observer window is visible without taking keyboard focus. */\n      if (g_strcmp0 (attr->startup_id, "selfme-observer_TIME1") == 0)\n        gtk_window_set_focus_on_map (GTK_WINDOW (window), FALSE);\n      else if (attr->startup_id != NULL)\n        gtk_window_set_startup_id (GTK_WINDOW (window), attr->startup_id);');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Xfce terminal source directory is required');
  const target = join(process.argv[2], 'terminal/terminal-app.c');
  await writeFile(target, observerTerminalSource(await readFile(target, 'utf8')));
}
