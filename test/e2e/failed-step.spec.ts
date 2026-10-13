import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fixtureDir, harnessUrl } from './paths';
import { git, graphRow } from './support';

/*
 * A rebase step git could not carry out: it could not replace dir/a.txt (on Windows, a file
 * another program has open; here a folder made read-only half-way through). Root ignores
 * permissions, so this runs as a normal user only.
 */
test.skip(process.platform === 'win32' || process.getuid?.() === 0, 'needs file permissions to apply');

/** A repository where a rebase stopped at "two", unable to replace dir/a.txt. */
function stoppedRebase(): { repo: string; head: string } {
  const repo = join(fixtureDir('failed-step'), 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  const commit = (subject: string, files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(repo, file, '..'), { recursive: true });
      writeFileSync(join(repo, file), content);
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', subject);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const one = commit('one', { 'dir/a.txt': '1\n', 'top.txt': '1\n' });
  const two = commit('two', { 'dir/a.txt': '2\n', 'top.txt': '2\n', 'new/x.txt': 'new\n' });
  const three = commit('three', { 'zz.txt': '3\n' });
  const todo = join(repo, '..', 'todo');
  writeFileSync(todo, `pick ${one}\nexec chmod a-w dir\npick ${two}\npick ${three}\n`);
  try {
    execFileSync(
      'git',
      ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'rebase', '-i', '--root'],
      {
        env: { ...process.env, GIT_SEQUENCE_EDITOR: `cp "${todo}"`, GIT_EDITOR: 'true' },
        stdio: 'ignore',
      },
    );
  } catch {
    // It stops at "two", as intended.
  }
  return { repo, head: three };
}

const banner = (page: Page) => page.getByRole('region', { name: 'Operation in progress' });
const unlock = (repo: string) => chmodSync(join(repo, 'dir'), 0o755);

test('the banner says a step could not be applied and why; Retry works once the file is free', async ({
  page,
}) => {
  const { repo } = stoppedRebase();
  try {
    await page.goto(harnessUrl({ repo }));
    // Stopped outside Lanefold: it knows the step, not git's words for why.
    await expect(banner(page)).toContainText('could not apply');
    await expect(banner(page)).toContainText(
      /Git could not apply [0-9a-f]{8}\. The Git Console shows what it printed\./,
    );
    await expect(banner(page).getByRole('button', { name: 'Continue' })).toHaveCount(0);

    // While the file is still held, Retry fails, saying why; the banner keeps the reason.
    await banner(page).getByRole('button', { name: 'Retry' }).click();
    const toast = page.getByRole('alert').filter({ hasText: 'Failed: Retry “two”' });
    await expect(toast).toContainText('Git could not replace dir/a.txt (Permission denied)');
    await expect(banner(page)).toContainText(
      'Git could not replace dir/a.txt (Permission denied): another program may have it open',
    );
    expect(git(repo, 'stash', 'list')).toBe('');

    unlock(repo);
    await banner(page).getByRole('button', { name: 'Retry' }).click();
    await expect(banner(page)).toBeHidden();
    await expect(graphRow(page, 'three')).toBeVisible();
    expect(git(repo, 'log', '--format=%s').split('\n')).toEqual(['three', 'two', 'one']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  } finally {
    unlock(repo);
  }
});

test('Abort puts the branch back, though the step’s new file stands in git’s way', async ({ page }) => {
  const { repo, head } = stoppedRebase();
  try {
    unlock(repo);
    await page.goto(harnessUrl({ repo }));
    await expect(banner(page)).toContainText('could not apply');
    await banner(page).getByRole('button', { name: 'Abort' }).click();
    await expect(banner(page)).toBeHidden();
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'stash', 'list')).toBe('');
  } finally {
    unlock(repo);
  }
});
