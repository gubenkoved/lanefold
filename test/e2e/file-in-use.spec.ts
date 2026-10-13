import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fixtureDir, harnessUrl } from './paths';
import { git, graphRow } from './support';

/*
 * Operations git cannot finish because it cannot replace dir/a.txt (on Windows, a file another
 * program has open; here a read-only folder). Root ignores permissions, so this runs as a
 * normal user only.
 */
test.skip(process.platform === 'win32' || process.getuid?.() === 0, 'needs file permissions to apply');

/** main: “one”; other: “two”, which changes dir/a.txt and top.txt. */
function twoBranches(): string {
  const repo = join(fixtureDir('file-in-use'), 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  const commit = (subject: string, files: Record<string, string>) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(repo, file, '..'), { recursive: true });
      writeFileSync(join(repo, file), content);
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', subject);
  };
  commit('one', { 'dir/a.txt': '1\n', 'top.txt': '1\n' });
  git(repo, 'checkout', '-q', '-b', 'other');
  commit('two', { 'dir/a.txt': '2\n', 'top.txt': '2\n', 'new/x.txt': 'new\n' });
  git(repo, 'checkout', '-q', 'main');
  return repo;
}

const lock = (repo: string) => chmodSync(join(repo, 'dir'), 0o555);
const unlock = (repo: string) => chmodSync(join(repo, 'dir'), 0o755);
const branch = (repo: string) => git(repo, 'branch', '--show-current');

async function switchToOther(page: Page): Promise<void> {
  await page
    .getByRole('complementary', { name: 'Branches' })
    .getByRole('treeitem', { name: 'other' })
    .dblclick();
}

test('a switch that could not update a file says so; Undo goes back while it is still held', async ({
  page,
}) => {
  const repo = twoBranches();
  try {
    lock(repo);
    await page.goto(harnessUrl({ repo }));
    await switchToOther(page);
    const toast = page.getByRole('alert').filter({ hasText: 'Checked out other' });
    await expect(toast).toContainText(
      'dir/a.txt still has the old content: git could not update it (Permission denied). Close the program that has it open, then update it.',
    );
    await expect(toast.getByRole('button', { name: 'Update the file…' })).toBeVisible();
    expect(branch(repo)).toBe('other');

    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => branch(repo)).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  } finally {
    unlock(repo);
  }
});

test('once the file is free, Update the file… finishes the switch', async ({ page }) => {
  const repo = twoBranches();
  try {
    lock(repo);
    await page.goto(harnessUrl({ repo }));
    await switchToOther(page);
    const toast = page.getByRole('alert').filter({ hasText: 'Checked out other' });
    await expect(toast).toContainText('dir/a.txt still has the old content');
    unlock(repo);
    await toast.getByRole('button', { name: 'Update the file…' }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText('dir/a.txt');
    await sheet.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, 'dir/a.txt'), 'utf8')).toBe('2\n');
    expect(branch(repo)).toBe('other');
  } finally {
    unlock(repo);
  }
});

test('a merge git gave up on half-way changes nothing, and Retry merges once the file is free', async ({
  page,
}) => {
  const repo = twoBranches();
  try {
    lock(repo);
    await page.goto(harnessUrl({ repo }));
    await graphRow(page, 'two').getByText('other', { exact: true }).click();
    await page.getByRole('menuitem', { name: /Merge into main/ }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: 'Merge', exact: true }).click();

    const toast = page.getByRole('alert').filter({ hasText: 'Failed: Merge other into main' });
    await expect(toast).toContainText(
      'Git could not replace dir/a.txt (Permission denied): another program may have it open, such as an editor, a build or antivirus. Close it, then retry. What git had already changed is back as before.',
    );
    expect(git(repo, 'status', '--porcelain')).toBe('');

    unlock(repo);
    await toast.getByRole('button', { name: 'Retry' }).click();
    // A merge is reviewed in its sheet, as when it was started.
    await sheet.getByRole('button', { name: 'Merge', exact: true }).click();
    await expect.poll(() => git(repo, 'log', '-1', '--format=%s')).toBe('two');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  } finally {
    unlock(repo);
  }
});
