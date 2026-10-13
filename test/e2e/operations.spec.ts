import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, git, graphRow, openedDiffs } from './support';

async function open(page: Page, repo: string): Promise<void> {
  await page.goto(harnessUrl({ repo }));
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

test('creates a branch from a commit through the review sheet, then undoes it', async ({ page }) => {
  const repo = copyDemo();
  await open(page, repo);
  await graphRow(page, 'Polish dashboard layout').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /New branch here/ }).click();

  const sheet = page.getByRole('dialog');
  await sheet.getByRole('textbox', { name: /Branch name/ }).fill('release/1.0');
  // The plan follows the input: the command preview names the branch.
  await expect(sheet).toContainText('switch -c release/1.0');
  await sheet.getByRole('button', { name: 'Create branch' }).click();
  await expect(sheet).toBeHidden();

  await expect(graphRow(page, 'Polish dashboard layout')).toContainText('release/1.0');
  expect(git(repo, 'branch', '--show-current')).toBe('release/1.0');

  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(graphRow(page, 'Polish dashboard layout')).not.toContainText('release/1.0');
  expect(git(repo, 'branch', '--show-current')).toBe('main');
  expect(git(repo, 'branch', '--list', 'release/1.0')).toBe('');
});

test('checking out a branch that local changes are in the way of carries them over', async ({ page }) => {
  const repo = copyDemo();
  await open(page, repo);
  // src/dashboard.css is changed here, and feature/login has its own version of it.
  await page
    .getByRole('complementary', { name: 'Branches' })
    .getByRole('treeitem', { name: 'login' })
    .dblclick();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('src/dashboard.css would be overwritten');
  await expect(sheet.getByRole('button', { name: 'Not possible' })).toBeDisabled();
  await sheet.getByRole('checkbox', { name: /Carry my uncommitted changes over/ }).check();
  await expect(sheet).toContainText('stash push');
  await expect(sheet).toContainText('stash pop --index');
  await sheet.getByRole('button', { name: 'Check out' }).click();
  await expect(sheet).toBeHidden();
  expect(git(repo, 'branch', '--show-current')).toBe('feature/login');
  // feature/login has no such file: the edit conflicts there, and is kept on the stash list too.
  const status = page.getByRole('status');
  await expect(status).toContainText('your changes conflict with the new branch in 1 file');
  expect(git(repo, 'stash', 'list')).toContain('lanefold: carried to feature/login');

  // Undo goes back with the changes exactly as they were. HEAD moves first and the files come
  // back after, so wait for Undo to say it is done.
  await status.getByRole('button', { name: 'Undo' }).click();
  await expect(status).toContainText('Back on main, files restored');
  expect(git(repo, 'branch', '--show-current')).toBe('main');
  expect(git(repo, 'status', '--porcelain')).toBe('A  NOTES.md\n M src/dashboard.css');
});

test('a hard reset is reviewed with its consequences before running', async ({ page }) => {
  const repo = copyDemo();
  await open(page, repo);
  await graphRow(page, 'Improve README').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Reset main to here/ }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('radio', { name: 'Hard' }).click();
  // The badge and the button say what it does.
  await expect(sheet).toContainText('Leaves commits behind · Discards changes');
  await expect(sheet.getByRole('button', { name: 'Reset main' })).toBeEnabled();
  await expect(sheet).toContainText('will no longer be on any branch');
  await expect(sheet).toContainText('Uncommitted changes');
  await expect(sheet).toContainText('reset --hard');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('Add dark mode toggle');
});

test('a conflicting merge stops with a banner and can be aborted', async ({ page }) => {
  const repo = copyDemo({ stash: true });
  git(repo, 'checkout', '-q', '-b', 'readme-rewrite', 'HEAD~2');
  execFileSync('sh', ['-c', `printf '# Aurora\\nRewritten.\\n' > '${join(repo, 'README.md')}'`]);
  git(repo, 'commit', '-qam', 'Rewrite README intro');
  git(repo, 'checkout', '-q', 'main');
  execFileSync('sh', ['-c', `printf '# Aurora\\nShorter.\\n' > '${join(repo, 'README.md')}'`]);
  git(repo, 'commit', '-qam', 'Shorten README');
  const head = git(repo, 'rev-parse', 'HEAD');

  await page.goto(harnessUrl({ repo }));
  await expect(graphRow(page, 'Shorten README')).toBeVisible();
  await graphRow(page, 'Rewrite README intro').getByText('readme-rewrite', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Merge into main/ }).click();

  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('Predicted conflicts');
  await sheet.getByRole('button', { name: 'Merge', exact: true }).click();

  const banner = page.getByRole('region', { name: 'Operation in progress' });
  // The sides are named by branch, never "ours/theirs".
  await expect(banner).toContainText('Merging readme-rewrite into main');
  await expect(banner).toContainText('1 conflict');
  await expect(banner.getByRole('button', { name: 'Keep main' })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Use readme-rewrite' })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Continue' })).toBeDisabled();

  // The file opens in the 3-way merge editor, its sides titled by branch.
  await banner.getByRole('button', { name: 'README.md', exact: true }).click();
  await expect
    .poll(async () => JSON.stringify(await openedDiffs(page)))
    .toContain('merge README.md: main ↔ readme-rewrite');

  // The uncommitted changes concludes the merge, once the conflict is resolved.
  await graphRow(page, 'Uncommitted changes').click();
  const card = page.getByRole('form', { name: 'Conclude merge' });
  await expect(card.getByRole('textbox', { name: 'Merge commit message' })).toHaveValue(
    "Merge branch 'readme-rewrite'",
  );
  await expect(card.getByRole('button', { name: /Conclude merge/ })).toBeDisabled();
  await expect(card).toContainText('Resolve 1 conflict first');

  await banner.getByRole('button', { name: 'Abort' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Abort', exact: true }).click();
  await expect(banner).toBeHidden();
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

async function dragTo(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

async function center(locator: ReturnType<Page['locator']>): Promise<{ x: number; y: number }> {
  // Rows and pills are re-rendered as metadata streams in: measure once it is there.
  for (let attempt = 0; ; attempt++) {
    await locator.waitFor();
    const box = await locator.boundingBox();
    if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    if (attempt > 20) throw new Error('Element has no box');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('dragging a branch onto HEAD offers merge, rebase and move', async ({ page }) => {
  const repo = copyDemo();
  await open(page, repo);
  const pill = graphRow(page, 'Show recent searches').getByText('feature/search', { exact: true });
  const head = graphRow(page, 'Add dark mode toggle');
  await dragTo(page, await center(pill), await center(head));
  await expect(page.getByRole('menuitem', { name: /Merge feature\/search into main/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Rebase main onto feature\/search/ })).toBeVisible();
  await page.getByRole('menuitem', { name: /Move feature\/search here/ }).click();
  // Its commits stay on origin/feature/search, so this is not destructive: it runs right away.
  await expect.poll(() => git(repo, 'rev-parse', 'feature/search')).toBe(git(repo, 'rev-parse', 'main'));
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(() => git(repo, 'log', '-1', '--format=%s', 'feature/search'))
    .toBe('Show recent searches');
});

test('dragging a selected commit onto HEAD cherry-picks it', async ({ page }) => {
  const repo = copyDemo({ stash: true });
  await page.goto(harnessUrl({ repo }));
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  // Adds a new file, so it applies cleanly (no conflict review needed).
  const commit = graphRow(page, 'Add city search box');
  await commit.click();
  await dragTo(page, await center(commit), await center(graphRow(page, 'Add dark mode toggle')));
  await page.getByRole('menuitem', { name: /Cherry-pick onto main/ }).click();
  await expect.poll(() => git(repo, 'log', '-1', '--format=%s', 'main')).toBe('Add city search box');
});

test('a cherry-pick that staged changes are in the way of says so instead of failing', async ({ page }) => {
  const repo = copyDemo();
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Add city search box').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Cherry-pick onto main/ }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText(
    '1 staged file is in the way: git cherry-picks only when nothing is staged',
  );
  await expect(sheet.getByRole('button', { name: 'Not possible' })).toBeDisabled();
  expect(git(repo, 'log', '-1', '--format=%s', 'main')).toBe('Add dark mode toggle');
});
