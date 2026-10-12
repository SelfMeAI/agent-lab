// Runs ONLY in an explicitly created disposable integration container.
// Uses real GIO/GVfs, not simulated trash records or a replacement file manager.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [phase, task] = process.argv.slice(1);
assert.ok(['prepare', 'restore'].includes(phase));
assert.match(task, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const root = '/home/node/.openclaw/workspace/selfme/' + task;
assert.equal(await readFile(join(root, '.selfme-workspace'), 'utf8'), task);
const data = '/home/node/.openclaw/.selfme-desktop/data';
assert.equal(process.env.XDG_DATA_HOME, data);
const name = '回收验证 native-trash-proof ' + task + '.txt';
const source = join(root, name), content = 'SelfMe native trash proof\n中文 / spaces / retained after container recreation\n';
const trash = join(data, 'Trash');
assert.equal((await stat(root)).dev, (await stat(trash)).dev, 'Trash must be on the retained task filesystem');
assert.equal((await stat('/home/node')).dev, (await stat(root)).dev, 'Native HOME must be on the retained task filesystem');

// Select only the native desktop bus, never dump process environments or keys.
let desktopEnv;
for (const pid of (await readdir('/proc')).filter(pid => /^\d+$/.test(pid))) {
  try {
    if ((await readFile('/proc/' + pid + '/comm', 'utf8')).trim() !== 'xfdesktop') continue;
    const env = Object.fromEntries((await readFile('/proc/' + pid + '/environ', 'utf8')).split('\0').flatMap(row => {
      const at = row.indexOf('='), key = row.slice(0, at);
      return ['DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME'].includes(key) ? [[key, row.slice(at + 1)]] : [];
    }));
    if (env.DBUS_SESSION_BUS_ADDRESS) { desktopEnv = env; break; }
  } catch { /* A child may retire during enumeration. */ }
}
assert.ok(desktopEnv?.DBUS_SESSION_BUS_ADDRESS, 'The managed desktop bus is required');
assert.equal(desktopEnv.XDG_DATA_HOME, data);
const env = { ...process.env, ...desktopEnv };
const gio = (...args) => execFileSync('gio', args, { env, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
async function entry() {
  for (const filename of await readdir(join(trash, 'info'))) {
    if (!filename.endsWith('.trashinfo')) continue;
    const info = await readFile(join(trash, 'info', filename), 'utf8');
    const original = info.match(/^Path=(.*)$/m)?.[1];
    if (original && decodeURIComponent(original) === source) return filename.slice(0, -'.trashinfo'.length);
  }
  throw new Error('Native original-path metadata is missing');
}
async function restore() {
  const filename = await entry(), uri = 'trash:///' + encodeURIComponent(filename);
  assert.equal(gio('cat', uri), content);
  assert.ok(gio('list', 'trash:///').includes(filename));
  await assert.rejects(stat(source), { code: 'ENOENT' });
  gio('move', uri, source);
  assert.equal(await readFile(source, 'utf8'), content);
  await assert.rejects(stat(join(trash, 'files', filename)), { code: 'ENOENT' });
}
if (phase === 'prepare') {
  await writeFile(source, content, { flag: 'wx', mode: 0o600 });
  gio('trash', source);
  await restore(); // Real Trash URI -> original path, content unchanged.
  gio('trash', source); // Leave it trashed across actual container recreation.
  const filename = await entry();
  assert.equal(await readFile(join(trash, 'files', filename), 'utf8'), content);
  await assert.rejects(stat(source), { code: 'ENOENT' });
} else await restore();
console.log(JSON.stringify({ phase, nativeTrash: true, nativeRestore: true, persistentFilesystem: true }));
