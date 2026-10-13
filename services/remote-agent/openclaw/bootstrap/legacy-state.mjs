import { lstat, mkdir, readFile, readdir, rename, realpath, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function info(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Offline, owned-volume migration. No merges, file overwrites or host paths. */
export async function migratePrivateDirectory(base, previous, current) {
  base = resolve(base);
  if (await realpath(base) !== base) throw new Error('服务数据根目录不能是符号链接');
  const oldPath = join(base, previous), newPath = join(base, current);
  const old = await info(oldPath), next = await info(newPath);
  if (next && (!next.isDirectory() || next.isSymbolicLink())) throw new Error('服务数据目录必须是真实目录，不能是符号链接');
  if (!old) return;
  if (old.isSymbolicLink()) {
    if (!next || await realpath(oldPath) !== newPath) throw new Error('旧服务数据链接不属于当前目录');
    return;
  }
  if (!old.isDirectory()) throw new Error('旧服务数据目录必须是真实目录');
  if (next) throw new Error('新旧服务目录同时存在，未合并或覆盖数据');
  await rename(oldPath, newPath);
  // Native histories, generated links and Trash metadata retain absolute paths.
  await symlink(current, oldPath);
}

export async function migrateOpenClawState(home = '/home/node/.openclaw') {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await migratePrivateDirectory(home, '.selfme-desktop', '.agent-lab-desktop');
  await migratePrivateDirectory(home, '.selfme-inputs', '.agent-lab-inputs');
  const workspace = join(home, 'workspace');
  await mkdir(workspace, { recursive: true });
  await migratePrivateDirectory(workspace, 'selfme', 'agent-lab');
  const tasks = join(workspace, 'agent-lab');
  const entries = await readdir(tasks, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const oldMarker = join(tasks, entry.name, '.selfme-workspace');
    const newMarker = join(tasks, entry.name, '.agent-lab-workspace');
    if (!await info(oldMarker)) continue;
    const old = await info(oldMarker);
    if (!old.isFile() || old.isSymbolicLink() || await readFile(oldMarker, 'utf8') !== entry.name) throw new Error('旧任务标识无效，未迁移');
    if (!await info(newMarker)) await rename(oldMarker, newMarker);
    else if (await readFile(newMarker, 'utf8') !== entry.name) throw new Error('新旧任务标识不一致，未覆盖');
  }
}

export function migrateOpenClawConfig(saved) {
  saved.plugins ??= {}; saved.plugins.entries ??= {}; saved.plugins.load ??= {};
  saved.plugins.allow = [...new Set((saved.plugins.allow ?? []).filter(id => id !== 'selfme-lab'))];
  saved.plugins.load.paths = [...new Set((saved.plugins.load.paths ?? []).filter(path => path !== '/opt/selfme/plugin'))];
  if (saved.plugins.entries['selfme-lab']) {
    saved.plugins.entries['agent-lab'] ??= saved.plugins.entries['selfme-lab'];
    delete saved.plugins.entries['selfme-lab'];
  }
  const providers = saved.models?.providers;
  if (providers?.selfme && !providers.agent_lab) providers.agent_lab = structuredClone(providers.selfme);
  const model = saved.agents?.defaults?.model;
  if (typeof model?.primary === 'string' && model.primary.startsWith('selfme/')) model.primary = 'agent_lab/' + model.primary.slice('selfme/'.length);
  // Keep the old provider alias for native historical per-session overrides.
  // All newly selected providers and tasks use the current identity.
  return saved;
}
