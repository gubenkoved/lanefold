import { expect, test, type Page } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, git, graphRow } from './support';

// Room for the whole demo history (rows out of view are not in the page) and its menus.
test.use({ viewport: { width: 1400, height: 800 } });

async function open(page: Page, repo?: string): Promise<void> {
  await page.goto(harnessUrl(repo ? { repo } : {}));
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

/** Drags a commit's row (by its subject, not a pill on it) onto another row. */
async function drag(page: Page, from: string, to: string): Promise<void> {
  const start = (await graphRow(page, from).locator('[class*="subject"]').boundingBox())!;
  const end = (await graphRow(page, to).boundingBox())!;
  await page.mouse.move(start.x + 12, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y + start.height / 2 + 8, { steps: 4 });
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('a disabled item says why when pointed at, and stays put when chosen', async ({ page }) => {
  await open(page);
  await graphRow(page, 'Initial commit').click({ button: 'right' });
  const menu = page.getByRole('menu');
  const merge = menu.getByRole('menuitem', { name: 'Merge into main' });
  await expect(merge).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: 'Rebase main onto here' })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: 'Cherry-pick onto main' })).toBeDisabled();
  // Idle, the footer invites pointing; on a disabled item it gives the reason.
  await expect(page.getByText('Point at an action for details')).toBeVisible();
  await merge.hover();
  await expect(page.getByText('main already contains it')).toBeVisible();
  // Clicked anyway (Playwright waits for enabled elements unless forced): nothing happens.
  await merge.click({ force: true });
  await expect(menu).toBeVisible();

  // The arrows reach disabled items too (they are skipped by nothing).
  await page.keyboard.press('Home');
  for (let i = 0; i < 20; i++) {
    if ((await menu.locator('[data-active="true"]').getAttribute('aria-disabled')) === 'true') break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(menu.locator('[data-active="true"]')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('commit menus: what HEAD already has is disabled, HEAD itself is not offered to itself', async ({
  page,
}) => {
  await open(page);
  // On main below its last merge: everything onto main does nothing; the editor cannot reach it.
  await graphRow(page, 'Initial commit').click({ button: 'right' });
  const reword = page.getByRole('menuitem', { name: 'Reword…' });
  await expect(reword).toBeDisabled();
  await reword.hover();
  await expect(page.getByText(/^Editing reaches back to the last merge, 6f7248cf$/)).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Edit history' })).toBeDisabled();
  await page.keyboard.press('Escape');

  // On another branch: the branch to check out.
  await graphRow(page, 'Debounce search requests').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Merge into main' })).toBeEnabled();
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await expect(page.getByText('Check out feature/search to edit it')).toBeVisible();
  await page.keyboard.press('Escape');

  // HEAD's own commit: no picking, merging, rebasing or comparing it onto itself.
  await graphRow(page, 'Add dark mode toggle').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Revert this commit' })).toBeVisible();
  for (const name of ['Cherry-pick onto main', 'Merge into main', 'Rebase main onto here'])
    await expect(page.getByRole('menuitem', { name })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('branch menus: the current branch leaves out acting on itself; merged branches say so', async ({
  page,
}) => {
  await open(page);
  await graphRow(page, 'Add dark mode toggle').getByText('main', { exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Branch main' });
  await expect(menu.getByRole('menuitem', { name: /Pull from origin\/main/ })).toBeVisible();
  for (const name of [/^Check out$/, /^Merge into main$/, /^Rebase main onto main$/, /^Compare with main$/])
    await expect(menu.getByRole('menuitem', { name })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Delete branch' }).hover();
  await expect(page.getByText('Check out another branch first')).toBeVisible();
  await page.keyboard.press('Escape');

  await graphRow(page, 'Remember the last signed-in user')
    .getByText('feature/login', { exact: true })
    .click();
  const merge = page.getByRole('menuitem', { name: 'Merge into main' });
  await expect(merge).toBeDisabled();
  await merge.hover();
  await expect(page.getByText('main already contains feature/login')).toBeVisible();
});

test('a right click on a branch or tag pill opens its menu, not its commit’s', async ({ page }) => {
  await open(page);
  await graphRow(page, 'Polish dashboard layout')
    .getByText('v1.0.0', { exact: true })
    .click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Tag v1.0.0' });
  await expect(menu.getByRole('menuitem', { name: 'Delete tag' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Open changes' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await graphRow(page, 'Show recent searches')
    .getByText('feature/search', { exact: true })
    .click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Branch feature/search' })).toBeVisible();
});

test('hints read as git commands or as notes', async ({ page }) => {
  await open(page);
  await graphRow(page, 'Improve README').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Revert this commit' }).hover();
  await expect(page.getByText('$ git revert 1c1a40e3')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: 'Drop commit…' }).hover();
  await expect(page.getByText('leave it out of the history', { exact: true })).toBeVisible();
  await expect(page.getByText('$ leave it out of the history')).toHaveCount(0);
});

test('dragging a commit onto another names both, and the fold names the commit', async ({ page }) => {
  await open(page);
  await graphRow(page, 'Update dependencies').click();
  await drag(page, 'Update dependencies', 'Improve README');
  const menu = page.getByRole('menu', { name: 'Update dependencies → 1c1a40e3' });
  await expect(menu.getByRole('menuitem', { name: 'Squash into “Improve README”…' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Fixup into “Improve README”…' })).toBeVisible();
  await expect(page.getByText(/drop commit/i)).toHaveCount(0);
});

test('a commit dropped short of HEAD says where to drop it, and the toast picks it', async ({ page }) => {
  const repo = copyDemo({ stash: true });
  await open(page, repo);
  await graphRow(page, 'Show recent searches').click();
  await drag(page, 'Show recent searches', 'Update dependencies');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: 'Drop it on main to cherry-pick it there' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cherry-pick onto main' }).click();
  await expect.poll(() => git(repo, 'log', '-1', '--format=%s')).toBe('Show recent searches');
});

test('uncommitted changes dropped where they cannot go say why', async ({ page }) => {
  await open(page);
  await graphRow(page, 'Uncommitted changes').click();
  await drag(page, 'Uncommitted changes', 'Debounce search requests');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: 'Check out feature/search to amend it' }),
  ).toBeVisible();
  await graphRow(page, 'Uncommitted changes').click();
  await drag(page, 'Uncommitted changes', 'Initial commit');
  await expect(
    page.getByRole('status').filter({ hasText: 'Amending reaches back to the last merge, 6f7248cf' }),
  ).toBeVisible();
});

test('uncommitted changes dropped with nothing staged: stage all and amend', async ({ page }) => {
  const repo = copyDemo();
  git(repo, 'reset', '-q');
  await open(page, repo);
  await graphRow(page, 'Uncommitted changes').click();
  await drag(page, 'Uncommitted changes', 'Improve README');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(
    page.getByRole('status').filter({ hasText: 'Nothing is staged to amend “Improve README” with' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stage all and amend…' }).click();
  // Everything is staged, and the amend waits for review.
  await expect(page.getByRole('dialog', { name: /^Amend .+ with the staged changes$/ })).toBeVisible();
  expect(git(repo, 'diff', '--cached', '--name-only').split('\n').sort()).toEqual([
    'NOTES.md',
    'src/dashboard.css',
  ]);
  await page.keyboard.press('Escape');
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('Add dark mode toggle');

  // With something staged, the drop offers the amend itself.
  await graphRow(page, 'Uncommitted changes').click();
  await drag(page, 'Uncommitted changes', 'Improve README');
  const menu = page.getByRole('menu', { name: 'Uncommitted changes → 1c1a40e3' });
  await expect(
    menu.getByRole('menuitem', { name: 'Amend “Improve README” with the staged changes…' }),
  ).toBeEnabled();
});

test('a menu keeps its width while the pointer moves between items with long and short hints', async ({
  page,
}) => {
  await open(page);
  await graphRow(page, 'Improve README').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy', exact: true }).hover();
  // The submenu: a whole commit hash for a hint, then items with short ones or none.
  const submenu = page.getByRole('menu').nth(1);
  await expect(submenu.getByRole('menuitem', { name: 'Commit hash' })).toBeVisible();
  const widths = new Set<number>();
  for (const name of ['Commit hash', 'Short hash', 'Subject', 'Full message', 'Commit hash']) {
    await submenu.getByRole('menuitem', { name }).hover();
    await expect(submenu.locator('[data-active="true"]')).toContainText(name);
    widths.add(Math.round((await submenu.boundingBox())!.width));
  }
  expect(widths.size).toBe(1);
});
