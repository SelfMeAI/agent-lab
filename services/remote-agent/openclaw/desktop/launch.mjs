import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { contextPath, checkedTask, showTerminal } from './session.mjs';
const run = promisify(execFile);
export async function launch(app) {
  const { task } = JSON.parse(await readFile(contextPath, 'utf8'));
  const { cwd } = await checkedTask(task);
  if (app === 'files') { await run('thunar', [cwd]); return; }
  if (app === 'terminal') { await showTerminal(task); return; }
  if (app !== 'browser') throw new Error('未知桌面入口');
  // Native authenticated browser APIs, never a second unmanaged profile.
  const call = async params => {
    const { stdout } = await run(process.execPath, ['/app/openclaw.mjs', 'gateway', 'call', 'browser.request', '--json', '--params', JSON.stringify({ ...params, tabScope: { sessionKey: 'agent:main:selfme:' + task } })], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  };
  const list = await call({ method: 'GET', path: '/tabs' });
  const tabs = list.tabs ?? [];
  const current = tabs.find(tab => tab.url !== 'about:blank') ?? tabs[0];
  const target = current ?? await call({ method: 'POST', path: '/tabs/open', body: { url: 'about:blank' } });
  await call({ method: 'POST', path: '/tabs/focus', body: { targetId: target.targetId } });
}
if (process.argv[1] === new URL(import.meta.url).pathname) launch(process.argv[2]).catch(error => {
  console.error('[selfme] Desktop launcher failed:', error.message);
  process.exitCode = 1;
});
