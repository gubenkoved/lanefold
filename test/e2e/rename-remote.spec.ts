import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
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

const onOrigin = (origin: string, branch: string) =>
  git(origin, 'branch', '--list', '--format=%(refname:short)', branch);

async function open(page: Page, repo: string): Promise<void> {
  await page.goto(harnessUrl({ repo }));
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

/** Opens the review of renaming `branch`, from its label in the graph row of `subject`. */
async function renameFromGraph(page: Page, subject: string, branch: string): Promise<Locator> {
  await graphRow(page, subject).getByText(branch, { exact: true }).click({ button: 'right' });
  await page
    .getByRole('menu', { name: `Branch ${branch}` })
    .getByRole('menuitem', { name: 'Rename…' })
    .click();
  return page.getByRole('dialog');
}

test('renames a branch on its remote too, after a review; Undo renames it back here only', async ({
  page,
}) => {
  const { repo, origin } = setup();
  await open(page, repo);
  const tip = git(repo, 'rev-parse', 'feature/search');
  const sheet = await renameFromGraph(page, 'Show recent searches', 'feature/search');
  await expect(sheet.getByRole('heading', { name: 'Rename feature/search', exact: true })).toBeVisible();
  const both = sheet.getByRole('checkbox', { name: /Also rename it on origin/ });
  await expect(both).not.toBeChecked();
  await sheet.getByRole('textbox', { name: 'New name' }).fill('feature/find');
  // Without it, the remote branch keeps its name.
  await expect(sheet).toContainText('The remote branch origin/feature/search keeps its name');
  await expect(sheet).not.toContainText('git push');
  await both.check();
  await expect(
    sheet.getByRole('heading', { name: 'Rename feature/search to feature/find, here and on origin' }),
  ).toBeVisible();
  await expect(sheet).toContainText('Renames it on the remote');
  await expect(sheet).toContainText(
    'git push --set-upstream --force-with-lease=refs/heads/feature/find: origin refs/heads/feature/find',
  );
  await expect(sheet).toContainText(
    `git push --force-with-lease=refs/heads/feature/search:${tip} origin --delete refs/heads/feature/search`,
  );
  await expect(sheet).toContainText('Undo renames the branch back here only, not on origin');
  await sheet.getByRole('button', { name: 'Rename both', exact: true }).click();
  await expect(sheet).toBeHidden();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Renamed feature/search to feature/find, here and on origin');
  expect(git(repo, 'branch', '--list', 'feature/search')).toBe('');
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'feature/find@{upstream}')).toBe('origin/feature/find');
  expect(onOrigin(origin, 'feature/search')).toBe('');
  expect(git(origin, 'rev-parse', 'feature/find')).toBe(tip);

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Undid “Rename feature/search to feature/find, here and on origin”');
  expect(git(repo, 'rev-parse', 'feature/search')).toBe(tip);
  expect(git(repo, 'branch', '--list', 'feature/find')).toBe('');
  // On origin it keeps the new name, which the branch tracks.
  expect(onOrigin(origin, 'feature/find')).toBe('feature/find');
  expect(onOrigin(origin, 'feature/search')).toBe('');
  expect(git(repo, 'rev-parse', '--abbrev-ref', 'feature/search@{upstream}')).toBe('origin/feature/find');
});

test('offers renaming it on the remote only for a branch with an upstream there', async ({ page }) => {
  const { repo } = setup();
  await open(page, repo);
  const sheet = await renameFromGraph(page, 'Try vector tiles', 'experiment/maps');
  await sheet.getByRole('textbox', { name: 'New name' }).fill('experiment/tiles');
  await expect(
    sheet.getByRole('heading', { name: 'Rename experiment/maps to experiment/tiles' }),
  ).toBeVisible();
  await expect(sheet.getByRole('checkbox')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
  expect(git(repo, 'branch', '--list', 'experiment/maps')).toBe('experiment/maps');
});
