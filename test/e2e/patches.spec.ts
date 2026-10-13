import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, debugUrl, git, graphRow } from './support';

test('saves a commit as a patch file, then recreates the commit from it', async ({ page, request }) => {
  const repo = copyDemo({ stash: 'including untracked' });
  const files = (params: Record<string, string> = {}) =>
    request
      .get(debugUrl(page, 'files', params))
      .then((response) => response.json() as Promise<{ saved: string[] }>);

  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Add dark mode toggle').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save as patch file…' }).click();
  await expect.poll(async () => (await files()).saved.length).toBe(1);
  const [patch] = (await files()).saved;
  expect(readFileSync(patch!, 'utf8')).toContain('Subject: [PATCH] Add dark mode toggle');

  // Drop the commit, then bring it back from the file.
  git(repo, 'reset', '-q', '--hard', 'HEAD~1');
  await expect(graphRow(page, 'Add dark mode toggle')).toBeHidden();
  // Let the reload that follows the reset settle before using the menus.
  await expect(graphRow(page, 'Improve README')).toBeVisible();
  await expect(page.getByText('19 commits')).toBeVisible();
  await files({ pick: patch! });
  await page
    .getByRole('button', { name: /aurora/ })
    .first()
    .click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Apply a patch file…' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('radio', { name: 'Recreate the commits' }).click();
  await expect(sheet).toContainText('git am --3way');
  await sheet.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  expect(git(repo, 'log', '-1', '--format=%s %an')).toBe('Add dark mode toggle Carol Chen');
});
