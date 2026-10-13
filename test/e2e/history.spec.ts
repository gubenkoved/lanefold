import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { DEMO_REPO, harnessUrl } from './paths';
import { copyDemo, debugUrl, git, gitRaw, graphRow, graphRows } from './support';

test('a file’s history opens from its row in the commit details', async ({ page }) => {
  await page.goto(harnessUrl());
  await graphRow(page, 'Update dependencies').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  await details.getByRole('button', { name: /forecast\.ts/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'History of this file' }).click();

  await expect(page.getByRole('tab', { name: /forecast\.ts/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('src/forecast.ts', { exact: true })).toBeVisible();
  await expect(graphRow(page, 'Fix timezone offset in daily view')).toBeVisible();
  // Commits that do not touch the file are not in this view.
  await expect(graphRow(page, 'Add login form component')).toBeHidden();
  await expect(graphRow(page, 'Uncommitted changes')).toBeHidden();

  // Lifting the limit shows the whole history.
  await page.getByRole('button', { name: 'Show the whole history' }).click();
  await expect(graphRow(page, 'Add login form component')).toBeVisible();
});

test('line history shows the commits that changed the selected lines', async ({ page, request }) => {
  await page.goto(harnessUrl());
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  const args = { repoId: DEMO_REPO, path: 'src/forecast.ts', start: 1, end: 5 };
  const response = await request.get(
    debugUrl(page, 'command', { command: 'openLineHistory', args: JSON.stringify(args) }),
  );
  expect(response.status()).toBe(204);

  await expect(page.getByRole('tab', { name: 'forecast.ts:1–5' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('src/forecast.ts:1–5')).toBeVisible();
  await expect(graphRows(page)).toHaveCount(3);
  // Newest first (rows are a recycled pool: their order is in aria-rowindex, not in the DOM).
  const order = ['Update dependencies', 'Cache forecast responses', 'Add forecast API client'];
  for (const [index, subject] of order.entries())
    await expect(graphRow(page, subject)).toHaveAttribute('aria-rowindex', String(index + 2));
});

test('restores an older version of a file from the commit details, and Undo puts it back', async ({
  page,
}) => {
  const repo = copyDemo();
  const current = readFileSync(join(repo, 'src/forecast.ts'), 'utf8');
  const polish = git(repo, 'log', '-1', '--format=%H', '--grep=Polish dashboard layout');
  const older = gitRaw(repo, 'show', `${polish}:src/forecast.ts`);
  expect(older).not.toBe(current);

  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Polish dashboard layout').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  await details.getByRole('button', { name: /forecast\.ts/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Restore this version' }).click();
  // Not destructive here (the file has no uncommitted edits): it runs at once, with Undo.
  await expect.poll(() => readFileSync(join(repo, 'src/forecast.ts'), 'utf8')).toBe(older);
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFileSync(join(repo, 'src/forecast.ts'), 'utf8')).toBe(current);
});
