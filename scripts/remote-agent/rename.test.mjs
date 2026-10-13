import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateOpenClawConfig, migrateOpenClawState, migratePrivateDirectory } from '../../services/remote-agent/openclaw/bootstrap/legacy-state.mjs';

test('owned-volume rename preserves histories, pending input, desktop trash and old absolute links', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-lab-rename-')));
  const task = 'c0ec83da-66be-4f17-a2c2-01dc02c89f00';
  try {
    await mkdir(join(root, 'workspace/selfme', task), { recursive: true });
    await writeFile(join(root, 'workspace/selfme', task, '.selfme-workspace'), task);
    await writeFile(join(root, 'workspace/selfme', task, 'result.txt'), 'retained artifact');
    await mkdir(join(root, '.selfme-inputs'));
    await writeFile(join(root, '.selfme-inputs/queue.sqlite'), 'retained queue bytes');
    await mkdir(join(root, '.selfme-desktop/home/.local/share/Trash/files'), { recursive: true });
    await writeFile(join(root, '.selfme-desktop/home/.local/share/Trash/files/recover.txt'), 'recoverable');
    await migrateOpenClawState(root); await migrateOpenClawState(root);
    assert.equal(await readFile(join(root, 'workspace/agent-lab', task, '.agent-lab-workspace'), 'utf8'), task);
    assert.equal(await readFile(join(root, 'workspace/selfme', task, 'result.txt'), 'utf8'), 'retained artifact');
    assert.equal(await realpath(join(root, 'workspace/selfme')), join(root, 'workspace/agent-lab'));
    assert.equal(await readFile(join(root, '.agent-lab-inputs/queue.sqlite'), 'utf8'), 'retained queue bytes');
    assert.equal(await readFile(join(root, '.agent-lab-desktop/home/.local/share/Trash/files/recover.txt'), 'utf8'), 'recoverable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rename refuses symlink attacks and conflicting directories instead of merging data', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-lab-rename-')));
  try {
    await mkdir(join(root, 'previous')); await mkdir(join(root, 'current'));
    await assert.rejects(migratePrivateDirectory(root, 'previous', 'current'), /同时存在/);
    await symlink('previous', join(root, 'link'));
    await assert.rejects(migratePrivateDirectory(root, 'previous', 'link'), /真实目录/);
    await assert.rejects(migratePrivateDirectory(root, 'link', 'current'), /不属于/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native config changes only integration identity, retaining provider accounts and old session aliases', () => {
  const saved = { plugins: { allow: ['browser', 'selfme-lab'], load: { paths: ['/opt/selfme/plugin', '/third-party/plugin'] }, entries: { 'selfme-lab': { enabled: true } } }, models: { providers: { selfme: { apiKey: 'private-fixture', models: [{ id: 'test' }] } } }, agents: { defaults: { model: { primary: 'selfme/test' } } } };
  migrateOpenClawConfig(saved); migrateOpenClawConfig(saved);
  assert.equal(saved.models.providers.agent_lab.apiKey, 'private-fixture');
  assert.equal(saved.models.providers.selfme.apiKey, 'private-fixture');
  assert.equal(saved.agents.defaults.model.primary, 'agent_lab/test');
  assert.equal(saved.plugins.entries['selfme-lab'], undefined);
  assert.deepEqual(saved.plugins.entries['agent-lab'], { enabled: true });
  assert.deepEqual(saved.plugins.load.paths, ['/third-party/plugin']);
});
