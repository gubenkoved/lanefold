import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DEMO_REMOTE, harnessUrl } from './paths';
import { copyDemo, git, graphRow } from './support';

test.use({ viewport: { width: 1440, height: 760 } });

/**
 * A private copy of the demo repository (without its uncommitted changes), with a private copy of
 * its remote as origin: these tests delete branches there, as merged pull requests' are.
 */
function setup(): { repo: string; origin: string } {
  const repo = copyDemo({ stash: true });
  const origin = join(dirname(repo), 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', DEMO_REMOTE, origin]);
  git(repo, 'remote', 'set-url', 'origin', origin);
  return { repo, origin };
}

const branchesPane = (page: Page) => page.getByRole('complementary', { name: 'Branches' });
const branchList = (repo: string) => git(repo, 'branch', '--list', '--format=%(refname:short)');

async function open(page: Page, repo: string): Promise<void> {
  await page.goto(harnessUrl({ repo }));
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

test('after Fetch and prune, a remote’s menu deletes the branches whose upstream is gone; Undo brings them back', async ({
  page,
}) => {
  const { repo, origin } = setup();
  // Two pull requests merged and their branches deleted on the remote.
  git(repo, 'branch', '--set-upstream-to=origin/review/maps', 'experiment/maps');
  git(origin, 'branch', '-D', 'feature/search', 'review/maps');
  await open(page, repo);
  const tree = branchesPane(page).getByRole('tree');
  const section = tree.getByRole('treeitem', { name: /^origin\s*\d/ });
  const menu = page.getByRole('menu', { name: 'Remote origin' });
  const entry = menu.getByRole('menuitem', { name: 'Delete branches whose upstream is gone…' });

  // Not yet: as of the last fetch, their upstreams are there.
  await section.click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: 'Fetch and prune' })).toBeVisible();
  await expect(entry).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Fetch and prune' }).click();
  await expect(page.getByRole('status')).toContainText('Fetched origin: 2 branches removed');
  await expect(section).toContainText('1');

  // A branch whose upstream is gone offers them all too.
  const filter = branchesPane(page).getByRole('textbox', { name: 'Filter branches and tags' });
  await filter.fill('feature/search');
  const row = tree.getByRole('treeitem', { name: 'feature/search' });
  await expect(row).toHaveAttribute('title', /origin\/feature\/search is gone/);
  await row.click({ button: 'right' });
  await expect(
    page
      .getByRole('menu', { name: 'Branch feature/search' })
      .getByRole('menuitem', { name: 'Delete branches whose upstream is gone…' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await filter.fill('');

  await section.click({ button: 'right' });
  await entry.click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Delete 2 branches' })).toBeVisible();
  await expect(sheet).toContainText('Leaves commits behind');
  await expect(sheet).toContainText('git branch -D --end-of-options experiment/maps feature/search');
  await expect(sheet).toContainText(
    '5 commits of experiment/maps and feature/search are on no other branch and will no longer be on any branch. Undo brings the branches back.',
  );
  await sheet.getByRole('button', { name: 'Delete branches', exact: true }).click();
  await expect(sheet).toBeHidden();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Deleted 2 branches');
  expect(branchList(repo)).toBe('feature/login\nhotfix/timezone\nmain');
  await expect(tree.getByRole('treeitem', { name: 'maps' })).toHaveCount(0);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Undid “Delete 2 branches”');
  expect(branchList(repo)).toBe('experiment/maps\nfeature/login\nfeature/search\nhotfix/timezone\nmain');
  // Tracking as before (their upstreams still gone).
  expect(git(repo, 'config', 'branch.feature/search.merge')).toBe('refs/heads/feature/search');
  expect(git(repo, 'config', 'branch.experiment/maps.merge')).toBe('refs/heads/review/maps');
});

test('the Branches section’s menu deletes them too; the branch checked out stays, as the review says', async ({
  page,
}) => {
  const { repo, origin } = setup();
  // Merged long ago, and its branch on the remote deleted since; feature/search's too.
  git(repo, 'config', 'branch.hotfix/timezone.remote', 'origin');
  git(repo, 'config', 'branch.hotfix/timezone.merge', 'refs/heads/hotfix/timezone');
  git(origin, 'branch', '-D', 'feature/search');
  git(repo, 'fetch', '-q', '--prune');
  git(repo, 'switch', '-q', 'feature/search');
  await open(page, repo);
  const tree = branchesPane(page).getByRole('tree');
  await tree.getByRole('treeitem', { name: /^Branches\s*\d/ }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Branches' });
  await expect(menu.getByRole('menuitem', { name: 'New branch…' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Delete branches whose upstream is gone…' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Delete branch hotfix/timezone' })).toBeVisible();
  await expect(sheet).toContainText(
    'feature/search is checked out, so it stays: switch to another branch to delete it.',
  );
  // Its commits are in the branch checked out: git’s -d deletes it.
  await expect(sheet).toContainText('git branch -d --end-of-options hotfix/timezone');
  await expect(sheet).not.toContainText('Leaves commits behind');
  await sheet.getByRole('button', { name: 'Delete branch', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('status')).toContainText('Deleted branch hotfix/timezone');
  expect(branchList(repo)).toBe('experiment/maps\nfeature/login\nfeature/search\nmain');
  await expect(tree.getByRole('treeitem', { name: 'timezone' })).toHaveCount(0);

  // Only the branch checked out is left: the entry says why it cannot go.
  await tree.getByRole('treeitem', { name: /^Branches\s*\d/ }).click({ button: 'right' });
  const left = menu.getByRole('menuitem', { name: 'Delete branches whose upstream is gone…' });
  await expect(left).toBeDisabled();
  await left.hover();
  await expect(page.getByText('feature/search is checked out: switch to another branch first')).toBeVisible();
});
