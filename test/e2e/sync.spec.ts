import { execFileSync } from 'node:child_process';
import { cpSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { DEMO_REMOTE, harnessUrl } from './paths';
import { copyDemo, git } from './support';

/** A private copy of the demo repository and its remote. */
function copyWithRemote(): { repo: string; remote: string; dir: string } {
  const repo = copyDemo();
  const dir = dirname(repo);
  const remote = join(dir, 'aurora-remote.git');
  cpSync(DEMO_REMOTE, remote, { recursive: true });
  git(repo, 'remote', 'set-url', 'origin', remote);
  return { repo, remote, dir };
}

test('pushes, then fetches and pulls what someone else pushed', async ({ page }) => {
  const { repo, remote, dir } = copyWithRemote();
  await page.goto(harnessUrl({ repo }));
  const sync = page.getByRole('group', { name: 'Sync' });
  await expect(sync.getByRole('button', { name: 'Push' })).toContainText('1');

  // Push the unpushed commit: no review needed (nothing on the remote is replaced).
  await sync.getByRole('button', { name: 'Push' }).click();
  await expect.poll(() => git(remote, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'main'));
  await expect(sync.getByRole('button', { name: 'Push' })).not.toContainText('1');

  // Someone else pushes.
  const other = join(dir, 'other');
  execFileSync('git', ['clone', '-q', remote, other]);
  writeFileSync(join(other, 'CHANGELOG.md'), '# Changes\n');
  git(other, 'add', 'CHANGELOG.md');
  git(other, 'commit', '-qm', 'Start a changelog');
  git(other, 'push', '-q', 'origin', 'main');

  await sync.getByRole('button', { name: 'Fetch' }).click();
  await expect(sync.getByRole('button', { name: 'Pull' })).toContainText('1');
  await sync.getByRole('button', { name: 'Pull' }).click();
  await expect.poll(() => git(repo, 'log', '-1', '--format=%s', 'main')).toBe('Start a changelog');
  await expect(sync.getByRole('button', { name: 'Pull' })).not.toContainText('1');
});
