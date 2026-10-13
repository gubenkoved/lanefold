import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, debugUrl } from './support';

test.use({ viewport: { width: 1440, height: 520 } });

test('opens a branch in a new worktree from the branches pane', async ({ page, request }) => {
  const repo = copyDemo();
  await page.goto(harnessUrl({ repo }));

  const pane = page.getByRole('complementary', { name: 'Branches' });
  await pane.getByRole('treeitem', { name: 'login' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open in a new worktree…' }).click();
  const sheet = page.getByRole('dialog');
  const folder = join(dirname(repo), 'aurora-feature-login');
  await expect(sheet.getByRole('textbox', { name: 'Folder' })).toHaveValue(folder);
  await expect(sheet).toContainText('git worktree add --');
  await sheet.getByRole('button', { name: 'Create worktree' }).click();
  await expect.poll(() => existsSync(join(folder, 'src/login.tsx'))).toBe(true);

  // The pane lists both worktrees and marks the branch as checked out elsewhere.
  const worktrees = pane.getByRole('group', { name: 'Worktrees' });
  await expect(worktrees).toContainText('aurora-feature-login');
  await expect(
    pane.getByRole('treeitem', { name: 'login' }).locator('[title^="Checked out in"]'),
  ).toBeVisible();

  await page.getByRole('status').getByRole('button', { name: 'Open in New Window' }).click();
  await expect
    .poll(async () => {
      const response = await request.get(debugUrl(page, 'host-commands'));
      return response.json() as Promise<unknown[]>;
    })
    .toEqual([{ command: 'openFolder', args: { path: folder } }]);
});
