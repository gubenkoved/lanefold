import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fixtureDir, harnessUrl } from './paths';
import { git, graphRow, openedDiffs } from './support';

test.use({ viewport: { width: 1440, height: 560 } });

/**
 * An app whose submodule libs/lib moved from lib's first commit to its third; lib's second
 * commit is checked out in it (another commit than the recorded one).
 */
function makeApp(): { app: string; commits: string[] } {
  const dir = fixtureDir('submodules');
  const lib = join(dir, 'lib');
  const app = join(dir, 'app');
  mkdirSync(lib, { recursive: true });
  mkdirSync(app);
  git(lib, 'init', '-q', '-b', 'main');
  const commits: string[] = [];
  for (const step of [1, 2, 3]) {
    writeFileSync(join(lib, 'lib.txt'), `step ${step}\n`);
    git(lib, 'add', 'lib.txt');
    git(lib, 'commit', '-q', '-m', `Lib step ${step}`);
    commits.push(git(lib, 'rev-parse', 'HEAD'));
  }
  git(app, 'init', '-q', '-b', 'main');
  writeFileSync(join(app, 'README.md'), '# App\n');
  git(app, 'add', 'README.md');
  git(app, 'commit', '-q', '-m', 'Start the app');
  git(app, 'submodule', 'add', '-q', '--', lib, 'libs/lib');
  const sub = join(app, 'libs/lib');
  git(sub, 'checkout', '-q', commits[0]!);
  git(app, 'add', 'libs/lib');
  git(app, 'commit', '-q', '-m', 'Add lib at step 1');
  git(sub, 'checkout', '-q', commits[2]!);
  git(app, 'add', 'libs/lib');
  git(app, 'commit', '-q', '-m', 'Move lib to step 3');
  git(sub, 'checkout', '-q', commits[1]!);
  return { app, commits };
}

const short = (sha: string) => sha.slice(0, 8);

const submodules = (page: Page) =>
  page.getByRole('complementary', { name: 'Branches' }).getByRole('tree', { name: 'Submodules' });

/** The repository chip at the top names the active repository (its title is the folder). */
const repoChip = (page: Page, folder: string) => page.locator('header').getByTitle(folder, { exact: true });

test('lists a submodule at another commit and updates it to the recorded one', async ({ page }) => {
  const { app, commits } = makeApp();
  await page.goto(harnessUrl({ repo: app }));
  const lib = submodules(page).getByRole('treeitem', { name: 'libs/lib: other commit' });
  await expect(lib).toBeVisible();

  await lib.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Update to the recorded commit…' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('git submodule update -- libs/lib');
  await expect(sheet).toContainText(
    `libs/lib’s HEAD moves from ${short(commits[1]!)} to ${short(commits[2]!)}`,
  );
  await expect(sheet).toContainText('Undo cannot take back');
  await sheet.getByRole('button', { name: 'Update', exact: true }).click();

  await expect.poll(() => git(join(app, 'libs/lib'), 'rev-parse', 'HEAD')).toBe(commits[2]);
  await expect(page.getByRole('status')).toContainText('libs/lib is at the commit this repository records.');
  await expect(submodules(page).getByRole('treeitem', { name: 'libs/lib: up to date' })).toBeVisible();
});

test('opens a submodule in Lanefold from the keyboard', async ({ page }) => {
  const { app } = makeApp();
  await page.goto(harnessUrl({ repo: app }));
  const tree = submodules(page);
  await expect(tree.getByRole('treeitem', { name: /^libs\/lib/ })).toBeVisible();
  await tree.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(tree).toHaveAttribute(
    'aria-activedescendant',
    (await tree.getByRole('treeitem', { name: /^libs\/lib/ }).getAttribute('id'))!,
  );
  await page.keyboard.press('Enter');

  // Lanefold now shows lib's own repository and history.
  await expect(repoChip(page, join(app, 'libs/lib'))).toBeVisible();
  await expect(graphRow(page, 'Lib step 2')).toBeVisible();
  await expect(graphRow(page, 'Move lib to step 3')).toBeHidden();
  // The app stays one menu away.
  await repoChip(page, join(app, 'libs/lib')).click();
  await page.getByRole('menuitemcheckbox', { name: /^app/ }).click();
  await expect(graphRow(page, 'Move lib to step 3')).toBeVisible();
});

test('shows the commits a submodule change brings, in the submodule', async ({ page }) => {
  const { app, commits } = makeApp();
  await page.goto(harnessUrl({ repo: app }));
  await graphRow(page, 'Move lib to step 3').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  const change = details.getByRole('button', { name: /lib/ }).filter({ hasText: '→' });
  await expect(change).toContainText(`${short(commits[0]!)} → ${short(commits[2]!)}`);

  await change.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show the commits in lib' }).click();

  // In lib's repository, a comparison of the two commits.
  await expect(repoChip(page, join(app, 'libs/lib'))).toBeVisible();
  await expect(
    page.getByRole('tab', { name: `${short(commits[0]!)} ↔ ${short(commits[2]!)}` }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toContainText('Lib step 3');
  await expect(page.getByRole('tabpanel')).toContainText('Lib step 2');
});

test('the working tree shows the submodule’s other commit, ready to stage', async ({ page }) => {
  const { app, commits } = makeApp();
  await page.goto(harnessUrl({ repo: app }));
  await graphRow(page, 'Uncommitted changes').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  const item = details.getByRole('listitem').filter({ hasText: 'lib' }).first();
  await expect(item).toContainText(`${short(commits[2]!)} → ${short(commits[1]!)}`);
  await item.hover();
  await item.getByRole('button', { name: 'Stage' }).click();
  await expect.poll(() => git(app, 'diff', '--cached', '--name-only')).toBe('libs/lib');
  await expect(details.getByText('Staged', { exact: true })).toBeVisible();
});

test('the form to add a submodule names its folder after the URL and checks it', async ({ page }) => {
  const { app } = makeApp();
  await page.goto(harnessUrl({ repo: app }));
  await submodules(page)
    .getByRole('treeitem', { name: /^Submodules/ })
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add a submodule…' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('textbox', { name: 'Repository URL' }).fill('https://example.com/team/charts.git');
  await expect(sheet.getByRole('textbox', { name: 'Folder' })).toHaveValue('charts');
  await expect(sheet).toContainText('git submodule add -- https://example.com/team/charts.git charts');

  await sheet.getByRole('textbox', { name: 'Folder' }).fill('libs/lib');
  // Said at the field it is about, which reads as invalid; the run button waits for a good one.
  await expect(sheet).toContainText('libs/lib is taken by the submodule libs/lib');
  await expect(sheet.getByRole('textbox', { name: 'Folder' })).toHaveAttribute('aria-invalid', 'true');
  await expect(sheet.getByRole('button', { name: 'Add submodule' })).toBeDisabled();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
});

/**
 * An app stopped in a merge of `side`, which moved libs/lib to another commit than main did
 * (neither follows from the other): a conflict over the submodule. Main's commit is checked out.
 */
function makeConflict(): { app: string; ours: string; theirs: string } {
  const dir = fixtureDir('submodules');
  const lib = join(dir, 'lib');
  const app = join(dir, 'app');
  mkdirSync(lib, { recursive: true });
  mkdirSync(app);
  git(lib, 'init', '-q', '-b', 'main');
  const commit = (message: string, text: string) => {
    writeFileSync(join(lib, 'lib.txt'), text);
    git(lib, 'add', 'lib.txt');
    git(lib, 'commit', '-q', '-m', message);
    return git(lib, 'rev-parse', 'HEAD');
  };
  const base = commit('Lib one', 'one\n');
  const ours = commit('Lib two', 'two\n');
  git(lib, 'checkout', '-q', '-b', 'alt', base);
  const theirs = commit('Lib alt', 'alt\n');
  git(lib, 'checkout', '-q', 'main');

  git(app, 'init', '-q', '-b', 'main');
  writeFileSync(join(app, 'README.md'), '# App\n');
  git(app, 'add', 'README.md');
  git(app, 'commit', '-q', '-m', 'Start the app');
  git(app, 'submodule', 'add', '-q', '--', lib, 'libs/lib');
  const sub = join(app, 'libs/lib');
  const record = (sha: string, message: string) => {
    git(sub, 'checkout', '-q', sha);
    git(app, 'add', 'libs/lib');
    git(app, 'commit', '-q', '-m', message);
  };
  record(base, 'Add lib');
  git(app, 'checkout', '-q', '-b', 'side');
  record(theirs, 'Side: lib alt');
  git(app, 'checkout', '-q', 'main');
  record(ours, 'Main: lib two');
  expect(() => git(app, 'merge', 'side')).toThrow();
  return { app, ours, theirs };
}

test('a conflicted submodule offers each side’s commit, never a text merge', async ({ page }) => {
  const { app, ours, theirs } = makeConflict();
  await page.goto(harnessUrl({ repo: app }));
  const banner = page.getByRole('region', { name: 'Operation in progress' });
  const item = banner.getByRole('listitem').filter({ hasText: 'libs/lib' });
  await expect(item).toContainText(`${short(ours)} ↔ ${short(theirs)}`);
  await expect(item.getByRole('button', { name: 'Keep main’s commit' })).toBeEnabled();
  await expect(item.getByRole('button', { name: /conflict markers/ })).toHaveCount(0);

  await item.getByRole('button', { name: 'Use side’s commit' }).click();
  await expect(page.getByRole('status')).toContainText(`libs/lib records ${short(theirs)}`);
  await expect(page.getByRole('status')).toContainText(`Its folder has ${short(ours)} checked out`);
  await expect
    .poll(() => git(app, 'ls-files', '--stage', '--', 'libs/lib'))
    .toBe(`160000 ${theirs} 0\tlibs/lib`);
  await expect(banner).toContainText('ready to continue');
  // No editor was asked to open anything.
  expect(await openedDiffs(page)).toEqual([]);
});

test('a commit made inside a submodule shows at once', async ({ page }) => {
  const { app, commits } = makeApp();
  const sub = join(app, 'libs/lib');
  git(sub, 'checkout', '-q', commits[2]!);
  await page.goto(harnessUrl({ repo: app }));
  await expect(submodules(page).getByRole('treeitem', { name: 'libs/lib: up to date' })).toBeVisible();
  writeFileSync(join(sub, 'lib.txt'), 'edited\n');
  await expect(submodules(page).getByRole('treeitem', { name: 'libs/lib: changed' })).toBeVisible();
  // Committing changes only the submodule's own git dir (in the app's .git/modules).
  git(sub, 'commit', '-q', '-am', 'Edit inside lib');
  await expect(submodules(page).getByRole('treeitem', { name: 'libs/lib: other commit' })).toBeVisible();
});

test('a deleted submodule folder is checked out again', async ({ page }) => {
  const { app, commits } = makeApp();
  rmSync(join(app, 'libs/lib'), { recursive: true, force: true });
  await page.goto(harnessUrl({ repo: app }));
  const lib = submodules(page).getByRole('treeitem', { name: 'libs/lib: not checked out' });
  await expect(lib).toBeVisible();
  // Among the changes it offers to come back, not to be staged as removed.
  await graphRow(page, 'Uncommitted changes').click();
  const item = page
    .getByRole('complementary', { name: 'Commit details' })
    .getByRole('listitem')
    .filter({ hasText: 'lib' })
    .first();
  await expect(item).toContainText(`was ${short(commits[2]!)}`);
  await item.hover();
  await expect(item.getByRole('button', { name: 'Check libs/lib out again…' })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Stage' })).toHaveCount(0);
  await lib.dblclick();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('git checks it out again from its repository, kept in .git/modules.');
  await sheet.getByRole('button', { name: 'Update', exact: true }).click();
  await expect.poll(() => existsSync(join(app, 'libs/lib/lib.txt'))).toBe(true);
  await expect(submodules(page).getByRole('treeitem', { name: 'libs/lib: up to date' })).toBeVisible();
});

test('the repository menu reaches submodules where the branches pane does not fit', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 640 });
  const { app } = makeApp();
  await page.goto(harnessUrl({ repo: app }));
  await expect(graphRow(page, 'Move lib to step 3')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Branches' })).toHaveCount(0);
  await repoChip(page, app).click();
  await page.getByRole('menuitem', { name: 'Submodules (1)…' }).click();
  // Each menu opens in place of the one before (no cascade to squeeze into the side bar).
  await page.getByRole('menuitem', { name: 'libs/lib · other commit' }).click();
  await expect(page.getByRole('menu')).toHaveCount(1);
  await page.getByRole('menuitem', { name: 'Update to the recorded commit…' }).click();
  await expect(page.getByRole('dialog')).toContainText('git submodule update -- libs/lib');
});
