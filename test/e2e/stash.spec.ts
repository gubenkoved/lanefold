import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, git, graphRow } from './support';

test('stashes the changes with a message, pops them back from the stash list, and undoes the pop', async ({
  page,
}) => {
  const repo = copyDemo();
  const before = git(repo, 'status', '--porcelain');
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Uncommitted changes').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  await details.getByRole('button', { name: 'Stash…' }).click();

  const sheet = page.getByRole('dialog');
  await sheet.getByRole('textbox', { name: 'Message' }).fill('Dashboard experiment');
  await expect(sheet).toContainText("stash push -m 'Dashboard experiment'");
  await sheet.getByRole('button', { name: 'Stash', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => git(repo, 'stash', 'list', '--format=%gs')).toBe('On main: Dashboard experiment');
  expect(git(repo, 'status', '--porcelain')).toBe('');
  await expect(graphRow(page, 'Uncommitted changes')).toBeHidden();

  // The top bar counts the stash and opens the stash list.
  await page.getByRole('button', { name: 'Stashes (1)' }).click();
  const list = page.getByRole('listbox', { name: 'Stashes' });
  await expect(list.getByRole('option', { name: /Dashboard experiment/ })).toBeVisible();
  const stashDetails = page.getByRole('complementary', { name: 'Stash details' });
  await expect(stashDetails.getByText('dashboard.css')).toBeVisible();
  await expect(stashDetails.getByText('staged', { exact: true })).toBeVisible();

  // Pop it, restoring what was staged.
  await stashDetails.getByRole('button', { name: 'Pop' }).click();
  await expect.poll(() => git(repo, 'status', '--porcelain')).toBe(before);
  // The pop's drop may still be finishing (git stash list fails while refs/stash is locked).
  await expect.poll(() => git(repo, 'stash', 'list')).toBe('');
  await expect(page.getByRole('heading', { name: 'No stashes' })).toBeVisible();

  // Undo the pop: the files go back to clean and the stash returns.
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => git(repo, 'stash', 'list', '--format=%gs')).toBe('On main: Dashboard experiment');
  await expect.poll(() => git(repo, 'status', '--porcelain')).toBe('');
  await expect(list.getByRole('option', { name: /Dashboard experiment/ })).toBeVisible();
});

test('drops a stash after review, from the keyboard', async ({ page }) => {
  const repo = copyDemo();
  git(repo, 'stash', 'push', '-q', '-m', 'Throwaway');
  await page.goto(harnessUrl({ repo }));
  await page.getByRole('button', { name: 'Stashes (1)' }).click();
  const list = page.getByRole('listbox', { name: 'Stashes' });
  await list.getByRole('option', { name: /Throwaway/ }).click();
  await page.keyboard.press('Delete');
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('stash drop stash@{0}');
  await sheet.getByRole('button', { name: 'Drop', exact: true }).click();
  await expect.poll(() => git(repo, 'stash', 'list')).toBe('');
  await expect(page.getByRole('heading', { name: 'No stashes' })).toBeVisible();
});

test('the stash list takes focus when it opens, so the arrow keys work right away', async ({ page }) => {
  const repo = copyDemo();
  git(repo, 'stash', 'push', '-q', '-m', 'First');
  writeFileSync(join(repo, 'README.md'), 'Second thoughts\n');
  git(repo, 'stash', 'push', '-q', '-m', 'Second');
  await page.goto(harnessUrl({ repo }));
  await page.getByRole('button', { name: 'Stashes (2)' }).click();
  const list = page.getByRole('listbox', { name: 'Stashes' });
  await expect(list).toBeFocused();
  await expect(list.getByRole('option', { selected: true })).toContainText('Second');
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('option', { selected: true })).toContainText('First');
  await expect(page.getByRole('complementary', { name: 'Stash details' })).toContainText('First');
});
