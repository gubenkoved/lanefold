import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DEMO_REMOTE, harnessUrl } from './paths';
import { copyDemo, git, graphRow } from './support';

test.use({ viewport: { width: 1440, height: 640 } });

/** A private copy of the demo repository, and bare repositories to add as remotes. */
function setup(): { repo: string; fork: string; moved: string; empty: string } {
  const repo = copyDemo();
  const dir = dirname(repo);
  const fork = join(dir, 'fork.git');
  execFileSync('git', ['clone', '-q', '--bare', DEMO_REMOTE, fork]);
  git(fork, 'branch', 'fork-only', 'main');
  const moved = join(dir, 'moved.git');
  execFileSync('git', ['clone', '-q', '--bare', fork, moved]);
  const empty = join(dir, 'empty.git');
  execFileSync('git', ['init', '-q', '--bare', empty]);
  return { repo, fork, moved, empty };
}

const branchesTree = (page: Page) => page.getByRole('complementary', { name: 'Branches' }).getByRole('tree');
/** A remote's section (its name, then its count of remote branches). */
const section = (page: Page, remote: string) =>
  branchesTree(page).getByRole('treeitem', { name: new RegExp(`^${remote}\\s*\\d`) });

test('adds a remote from the branches pane, fetches it, renames it, re-points it and removes it', async ({
  page,
}) => {
  const { repo, fork, moved } = setup();
  await page.goto(harnessUrl({ repo }));
  const tree = branchesTree(page);
  const sheet = page.getByRole('dialog');

  // Added without fetching: its section says so, and offers to fetch.
  await tree.getByRole('treeitem', { name: 'Add remote…' }).click();
  await sheet.getByRole('textbox', { name: 'Name' }).fill('upstream');
  await sheet.getByRole('textbox', { name: 'URL' }).fill(fork);
  await sheet.getByRole('checkbox', { name: 'Fetch its branches right away' }).uncheck();
  await expect(sheet).toContainText(`git remote add -- upstream ${fork}`);
  await expect(sheet).not.toContainText('git fetch');
  await sheet.getByRole('button', { name: 'Add remote', exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(git(repo, 'remote', 'get-url', 'upstream')).toBe(fork);
  await expect(section(page, 'upstream')).toBeVisible();
  const unfetched = tree.getByRole('treeitem', { name: /No branches fetched yet/ });
  await expect(unfetched).toBeVisible();

  // Fetched: its branches appear, and the result says what came.
  await unfetched.getByRole('button', { name: 'Fetch' }).click();
  await expect(tree.getByRole('treeitem', { name: 'fork-only' })).toBeVisible();
  await expect(unfetched).toBeHidden();
  await expect(page.getByRole('status')).toContainText('Fetched upstream: 4 new branches');

  // Renamed: its remote branches follow.
  await section(page, 'upstream').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await sheet.getByRole('textbox', { name: 'New name' }).fill('fork');
  await expect(sheet).toContainText('git remote rename upstream fork');
  await sheet.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(section(page, 'fork')).toBeVisible();
  await expect(section(page, 'upstream')).toHaveCount(0);
  expect(git(repo, 'branch', '-r', '--list', 'fork/fork-only')).toBe('fork/fork-only');

  // Pointed elsewhere: the form starts from the URL it has.
  await section(page, 'fork').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Change URL…' }).click();
  await expect(sheet.getByRole('textbox', { name: 'URL' })).toHaveValue(fork);
  await sheet.getByRole('textbox', { name: 'URL' }).fill(moved);
  await expect(sheet).toContainText(`git remote set-url -- fork ${moved}`);
  await sheet.getByRole('button', { name: 'Change URL', exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(git(repo, 'remote', 'get-url', 'fork')).toBe(moved);

  // Removed after a review that lists the remote branches going with it.
  await section(page, 'fork').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove…' }).click();
  await expect(sheet).toContainText('Deletes remote branches');
  await expect(sheet).toContainText('fork/fork-only');
  await expect(sheet).toContainText('git remote remove fork');
  await sheet.getByRole('button', { name: 'Remove remote', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(section(page, 'fork')).toHaveCount(0);
  expect(git(repo, 'remote')).toBe('origin');
  expect(git(repo, 'branch', '-r', '--list', 'fork/*')).toBe('');
});

test('a remote’s actions are at hand from the keyboard', async ({ page }) => {
  const { repo } = setup();
  await page.goto(harnessUrl({ repo }));
  const origin = section(page, 'origin');
  // A click focuses the section (and folds it); the arrow unfolds it again.
  await origin.click();
  await expect(origin).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(origin).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu');
  await expect(menu).toContainText('Remote origin');
  await expect(menu.getByRole('menuitem', { name: 'Fetch origin' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  const sheet = page.getByRole('dialog');
  await page.keyboard.press('F2');
  await expect(sheet.getByRole('textbox', { name: 'New name' })).toHaveValue('origin');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Delete reviews the removal: what goes, and the upstreams it clears.
  await page.keyboard.press('Delete');
  await expect(sheet).toContainText('Remove remote origin');
  await expect(sheet).toContainText('lose their upstream (origin/feature/search, origin/main)');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  expect(git(repo, 'remote')).toBe('origin');
});

test('a repository without remotes offers to add one: in the top bar, and where a push needs one', async ({
  page,
}) => {
  const { repo, fork } = setup();
  git(repo, 'remote', 'remove', 'origin');
  await page.goto(harnessUrl({ repo }));
  await expect(page.getByRole('banner').getByRole('button', { name: 'Add remote…' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Sync' })).toHaveCount(0);

  // Commit & Push: the push has nowhere to go, and its review offers to add a remote first.
  await graphRow(page, 'Uncommitted changes').click();
  const commit = page
    .getByRole('complementary', { name: 'Commit details' })
    .getByRole('form', { name: 'Commit' });
  await commit.getByRole('textbox', { name: 'Commit message' }).fill('Write notes');
  await commit.getByRole('button', { name: 'Commit & Push' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('This repository has no remote to push to.');
  await sheet.getByRole('button', { name: 'Add remote…' }).click();
  await expect(sheet.getByRole('textbox', { name: 'Name' })).toHaveValue('origin');
  await sheet.getByRole('textbox', { name: 'URL' }).fill(fork);
  await expect(sheet).toContainText('git fetch origin');
  await sheet.getByRole('button', { name: 'Add remote', exact: true }).click();

  // Then back to the push, which now has a remote.
  await expect(sheet.getByRole('heading', { name: 'Push main' })).toBeVisible();
  await expect(sheet).toContainText('git push --set-upstream origin main');
  await sheet.getByRole('button', { name: 'Push', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => git(fork, 'log', '-1', '--format=%s', 'main')).toBe('Write notes');
  await expect(page.getByRole('status')).toContainText('Pushed main to origin (2 commits)');
  await expect(page.getByRole('group', { name: 'Sync' })).toBeVisible();
});

test('publishes a branch to a remote never fetched, from the branch’s menu', async ({ page }) => {
  const { repo, empty } = setup();
  git(repo, 'remote', 'remove', 'origin');
  git(repo, 'remote', 'add', 'origin', empty);
  await page.goto(harnessUrl({ repo }));
  const tree = branchesTree(page);
  await expect(tree.getByRole('treeitem', { name: /No branches fetched yet/ })).toBeVisible();

  await tree.getByRole('treeitem', { name: 'timezone' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Publish branch' }).click();
  // Nothing on the remote is replaced: it runs right away, and says what it did.
  await expect(page.getByRole('status')).toContainText('Published hotfix/timezone to origin (');
  expect(git(empty, 'rev-parse', 'hotfix/timezone')).toBe(git(repo, 'rev-parse', 'hotfix/timezone'));
  await expect(tree.getByRole('treeitem', { name: /No branches fetched yet/ })).toBeHidden();
  await expect(section(page, 'origin')).toContainText('1');
});

test('in a narrow view, the repository menu manages the remotes', async ({ page }) => {
  const { repo } = setup();
  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto(harnessUrl({ repo }));
  // The sync controls show once the remotes are known (the menu lists them as it opens).
  await expect(page.getByRole('group', { name: 'Sync' })).toBeVisible();
  // No room for the branches pane here.
  await expect(page.getByRole('complementary', { name: 'Branches' })).toHaveCount(0);

  await page
    .getByRole('banner')
    .getByRole('button', { name: /aurora/ })
    .click();
  await page.getByRole('menuitem', { name: 'origin', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('textbox', { name: 'New name' }).fill('upstream');
  await expect(sheet).toContainText('git remote rename origin upstream');
  await sheet.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(sheet).toBeHidden();
  expect(git(repo, 'remote')).toBe('upstream');
});
