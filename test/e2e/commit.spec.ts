import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, git, graphRow } from './support';

/** Opens the repository with the uncommitted changes selected. */
async function openChanges(page: Page, repo: string) {
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Uncommitted changes').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  await expect(details.getByRole('heading', { name: 'Uncommitted changes' })).toBeVisible();
  return details;
}

/** A file's row in the details pane (its actions appear on hover). */
function fileRow(details: Locator, name: string) {
  return details.getByRole('listitem').filter({ hasText: name }).first();
}

test('stages a file, commits from the details pane, and Undo puts the changes back', async ({ page }) => {
  const repo = copyDemo();
  const before = git(repo, 'rev-parse', 'HEAD');
  const details = await openChanges(page, repo);

  const css = fileRow(details, 'dashboard.css');
  await css.hover();
  await css.getByRole('button', { name: 'Stage' }).click();
  await expect.poll(() => git(repo, 'diff', '--cached', '--name-only')).toContain('src/dashboard.css');

  const commit = details.getByRole('form', { name: 'Commit' });
  await expect(commit.getByRole('button', { name: 'Commit 2 files' })).toBeDisabled();
  await commit.getByRole('textbox', { name: 'Commit message' }).fill('Write notes and tweak the dashboard');
  await commit.getByRole('textbox', { name: 'Commit message' }).press('Control+Enter');

  await expect(graphRow(page, 'Write notes and tweak the dashboard')).toBeVisible();
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('Write notes and tweak the dashboard');
  expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(before);
  expect(git(repo, 'status', '--porcelain')).toBe('');

  // Undo takes the commit back; its changes stay staged.
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(graphRow(page, 'Write notes and tweak the dashboard')).toBeHidden();
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  expect(git(repo, 'diff', '--cached', '--name-only').split('\n').sort()).toEqual([
    'NOTES.md',
    'src/dashboard.css',
  ]);
});

test('discards a file’s changes after review, and Undo brings them back', async ({ page }) => {
  const repo = copyDemo();
  const edited = readFileSync(join(repo, 'src/dashboard.css'), 'utf8');
  const details = await openChanges(page, repo);

  const css = fileRow(details, 'dashboard.css');
  await css.hover();
  await css.getByRole('button', { name: /Discard changes/ }).click();

  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('restore --worktree -- src/dashboard.css');
  await expect(sheet).toContainText('Undo brings them back');
  await sheet.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => git(repo, 'status', '--porcelain', '--', 'src/dashboard.css')).toBe('');
  // The staged file is untouched.
  expect(git(repo, 'diff', '--cached', '--name-only')).toBe('NOTES.md');

  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFileSync(join(repo, 'src/dashboard.css'), 'utf8')).toBe(edited);
  expect(git(repo, 'diff', '--cached', '--name-only')).toBe('NOTES.md');
});
