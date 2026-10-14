import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DEMO_REMOTE, harnessUrl } from './paths';
import { copyDemo, git, graphRow } from './support';

test.use({ viewport: { width: 1440, height: 760 } });

/**
 * A private copy of the demo repository, with a private copy of its remote as origin (these
 * tests change what is on the remote).
 */
function setup(): { repo: string; origin: string } {
  const repo = copyDemo();
  const origin = join(dirname(repo), 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', DEMO_REMOTE, origin]);
  git(repo, 'remote', 'set-url', 'origin', origin);
  return { repo, origin };
}

const branchesPane = (page: Page) => page.getByRole('complementary', { name: 'Branches' });
const onOrigin = (origin: string, branch: string) =>
  git(origin, 'branch', '--list', '--format=%(refname:short)', branch);

async function open(page: Page, repo: string): Promise<void> {
  await page.goto(harnessUrl({ repo }));
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

/** Opens the menu of a remote branch in the branches pane, found by filtering for it. */
async function remoteBranchMenu(page: Page, name: string): Promise<void> {
  const pane = branchesPane(page);
  await pane.getByRole('textbox', { name: 'Filter branches and tags' }).fill(name);
  await pane.getByRole('tree').getByRole('treeitem', { name }).click({ button: 'right' });
}

test('deletes a branch from its remote, after a review that says Undo cannot bring it back', async ({
  page,
}) => {
  const { repo, origin } = setup();
  await open(page, repo);
  const tip = git(repo, 'rev-parse', 'origin/review/maps');

  await remoteBranchMenu(page, 'review/maps');
  const menu = page.getByRole('menu', { name: 'Remote branch origin/review/maps' });
  await menu.getByRole('menuitem', { name: 'Delete from origin…' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Delete branch review/maps from origin' })).toBeVisible();
  await expect(sheet).toContainText('Deletes it from the remote');
  await expect(sheet).toContainText(
    `git push --force-with-lease=refs/heads/review/maps:${tip} origin --delete refs/heads/review/maps`,
  );
  await expect(sheet).toContainText('Undo cannot bring it back there');
  await sheet.getByRole('button', { name: 'Delete from remote', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('status')).toContainText('Deleted review/maps from origin');
  expect(onOrigin(origin, 'review/maps')).toBe('');
  await expect(branchesPane(page).getByRole('treeitem', { name: 'review/maps' })).toHaveCount(0);
  await expect(branchesPane(page).getByText('No branches or tags match “review/maps”.')).toBeVisible();
});

test('the Delete key reviews deleting a remote branch from its remote', async ({ page }) => {
  const { repo, origin } = setup();
  await open(page, repo);
  const pane = branchesPane(page);
  await pane.getByRole('textbox', { name: 'Filter branches and tags' }).fill('review/maps');
  await pane.getByRole('tree').getByRole('treeitem', { name: 'review/maps' }).click();
  await page.keyboard.press('Delete');
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Delete branch review/maps from origin' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
  expect(onOrigin(origin, 'review/maps')).toBe('review/maps');
});

test('deletes a branch with its remote branch; Undo brings the branch back, tracking as before', async ({
  page,
}) => {
  const { repo, origin } = setup();
  await open(page, repo);
  await graphRow(page, 'Show recent searches')
    .getByText('feature/search', { exact: true })
    .click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Branch feature/search' })
    .getByRole('menuitem', { name: 'Delete branch and origin/feature/search…' })
    .click();
  const sheet = page.getByRole('dialog');
  await expect(
    sheet.getByRole('heading', { name: 'Delete branch feature/search and origin/feature/search' }),
  ).toBeVisible();
  const both = sheet.getByRole('checkbox', { name: /Also delete origin\/feature\/search from the remote/ });
  await expect(both).toBeChecked();
  // Without it, the remote branch stays.
  await both.uncheck();
  await expect(
    sheet.getByRole('heading', { name: 'Delete branch feature/search', exact: true }),
  ).toBeVisible();
  await expect(sheet).not.toContainText('git push');
  await both.check();
  await expect(sheet).toContainText('origin --delete refs/heads/feature/search');
  await sheet.getByRole('button', { name: 'Delete both', exact: true }).click();
  await expect(sheet).toBeHidden();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Deleted branch feature/search and origin/feature/search');
  expect(git(repo, 'branch', '--list', 'feature/search')).toBe('');
  expect(onOrigin(origin, 'feature/search')).toBe('');

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Undid “Delete branch feature/search and origin/feature/search”');
  expect(git(repo, 'branch', '--list', 'feature/search')).toBe('feature/search');
  expect(git(repo, 'config', 'branch.feature/search.merge')).toBe('refs/heads/feature/search');
  expect(onOrigin(origin, 'feature/search')).toBe('');
});

test('sets a branch’s upstream from a list of remote branches, and stops tracking it', async ({ page }) => {
  const { repo } = setup();
  await open(page, repo);
  await graphRow(page, 'Try vector tiles')
    .getByText('experiment/maps', { exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Set upstream…' }).click();
  const picker = page.getByRole('dialog', { name: 'Upstream of experiment/maps' });
  await picker.getByRole('option', { name: /origin\/review\/maps/ }).click();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Set the upstream of experiment/maps to origin/review/maps');
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'experiment/maps@{upstream}')).toBe('origin/review/maps');
  // The branches pane shows it tracking.
  const pane = branchesPane(page);
  await pane.getByRole('textbox', { name: 'Filter branches and tags' }).fill('experiment/maps');
  const row = pane.getByRole('tree').getByRole('treeitem', { name: 'experiment/maps' });
  await expect(row).toHaveAttribute('title', /tracks origin\/review\/maps/);

  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Stop tracking origin/review/maps' }).click();
  await expect(toast).toContainText('Stopped tracking origin/review/maps');
  expect(git(repo, 'for-each-ref', '--format=%(upstream)', 'refs/heads/experiment/maps')).toBe('');
  await expect(row).not.toHaveAttribute('title', /tracks/);
});

test('fast-forwards a branch that is not checked out to its upstream, with Undo', async ({ page }) => {
  const { repo } = setup();
  const upstream = git(repo, 'rev-parse', 'origin/feature/search');
  git(repo, 'branch', '-f', 'feature/search', 'feature/search~1');
  await open(page, repo);
  await graphRow(page, 'Debounce search requests')
    .getByText('feature/search', { exact: true })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Fast-forward to origin/feature/search' }).click();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Moved feature/search to origin/feature/search');
  expect(git(repo, 'rev-parse', 'feature/search')).toBe(upstream);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Undid');
  expect(git(repo, 'rev-parse', 'feature/search')).toBe(git(repo, 'rev-parse', `${upstream}~1`));
});

test('fetch and prune forgets the remote branches deleted on the remote', async ({ page }) => {
  const { repo, origin } = setup();
  git(origin, 'branch', '-D', 'review/maps');
  await open(page, repo);
  const tree = branchesPane(page).getByRole('tree');
  const section = tree.getByRole('treeitem', { name: /^origin\s*\d/ });
  await expect(section).toContainText('3');
  await section.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Fetch and prune' }).click();
  await expect(page.getByRole('status')).toContainText('Fetched origin: 1 branch removed');
  await expect(section).toContainText('2');
  expect(git(repo, 'branch', '-r', '--list', 'origin/review/maps')).toBe('');
});
