import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, git, graphRow, historyEditor, planRow } from './support';

/*
 * The review sheets, their confirmations and the banner of a stopped operation: what they say,
 * and how they behave from the keyboard.
 */

test.use({ reducedMotion: 'reduce' });

async function open(page: Page, repo: string): Promise<void> {
  await page.goto(harnessUrl({ repo }));
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

const banner = (page: Page) => page.getByRole('region', { name: 'Operation in progress' });

test('Enter right after typing runs once the plan for what was typed is there', async ({ page }) => {
  const repo = copyDemo();
  await open(page, repo);
  await graphRow(page, 'Add dark mode toggle').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /New tag/ }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('textbox', { name: 'Tag name' })).toBeFocused();
  // Faster than the plan follows (it is made again shortly after each key): Enter comes while
  // the plan on screen is still the one for an earlier name.
  await page.keyboard.type('v7.0.0', { delay: 90 });
  await page.keyboard.press('Enter');
  await expect(sheet).toBeHidden();
  expect(git(repo, 'tag', '--list', 'v7.0.0')).toBe('v7.0.0');
  await expect(page.getByRole('status')).toContainText('Created tag v7.0.0');
});

test('Enter right after typing a name that is taken runs nothing and says why at the field', async ({
  page,
}) => {
  const repo = copyDemo();
  await open(page, repo);
  await graphRow(page, 'Add dark mode toggle').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /New branch here/ }).click();
  const sheet = page.getByRole('dialog');
  const name = sheet.getByRole('textbox', { name: 'Branch name' });
  await expect(name).toBeFocused();
  await page.keyboard.type('feature/login', { delay: 40 });
  await page.keyboard.press('Enter');
  // The fresh plan cannot run: the sheet stays, the field is marked and keeps focus.
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription('A branch named feature/login already exists.');
  await expect(name).toBeFocused();
  await expect(sheet.getByRole('button', { name: 'Create branch' })).toBeDisabled();
  expect(git(repo, 'branch', '--show-current')).toBe('main');
});

test('a run asked for before the plan caught up is held back when the plan turns riskier', async ({
  page,
}) => {
  const repo = copyDemo();
  await open(page, repo);
  await graphRow(page, 'Improve README').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Reset main to here/ }).click();
  const sheet = page.getByRole('dialog');
  const mode = sheet.getByRole('radiogroup', { name: 'Mode' });
  await mode.getByRole('radio', { name: 'Keep' }).click();
  await expect(sheet).toContainText('reset --keep');
  await expect(sheet).toContainText('Leaves commits behind');
  // Hard, and Run before its plan is there: it would discard changes nobody was shown yet.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+Enter');
  await expect(sheet).toContainText('Not run yet: look over what changed, then run it.');
  await expect(sheet).toContainText('Leaves commits behind · Discards changes');
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('Add dark mode toggle');
  // Asked again, with that on screen, it runs.
  await sheet.getByRole('button', { name: 'Reset main' }).click();
  await expect(sheet).toBeHidden();
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('Improve README');
});

test('what a form lacks is a hint until it is wrong: then an error at its field, read out', async ({
  page,
}) => {
  const repo = copyDemo();
  await open(page, repo);
  await graphRow(page, 'Add dark mode toggle').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /New branch here/ }).click();
  const sheet = page.getByRole('dialog');
  const name = sheet.getByRole('textbox', { name: 'Branch name' });
  await expect(name).toHaveAccessibleDescription('Enter a name for the branch.');
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  await expect(sheet.locator('[aria-live="polite"]')).toHaveText('');

  await name.fill('feature/login');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(sheet.locator('[aria-live="polite"]')).toHaveText(
    'A branch named feature/login already exists.',
  );
  // Nothing pretends to happen: no effects, and the commands are only what would run.
  await expect(sheet).not.toContainText('What changes');
  await expect(sheet.getByRole('heading', { name: 'Git commands' }).locator('xpath=../..')).toHaveAttribute(
    'data-dimmed',
    'true',
  );

  await name.fill('feature/dark-mode');
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  await expect(sheet).toContainText('What changes');
  await expect(sheet.getByRole('button', { name: 'Create branch' })).toBeEnabled();
});

test('choices in a sheet are radio groups: one tab stop, arrow keys move the choice', async ({ page }) => {
  const repo = copyDemo();
  await open(page, repo);
  await graphRow(page, 'Improve README').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Reset main to here/ }).click();
  const sheet = page.getByRole('dialog');
  const mode = sheet.getByRole('radiogroup', { name: 'Mode' });
  await expect(mode.getByRole('radio')).toHaveCount(4);
  await expect(mode.locator('[tabindex="0"]')).toHaveCount(1);
  await mode.getByRole('radio', { name: 'Mixed' }).click();
  await expect(mode).toHaveAccessibleDescription('Keep your files; those changes become unstaged.');
  await page.keyboard.press('ArrowRight');
  const keep = mode.getByRole('radio', { name: 'Keep' });
  await expect(keep).toBeFocused();
  await expect(keep).toHaveAttribute('aria-checked', 'true');
  await expect(keep).toHaveAttribute('tabindex', '0');
  await expect(sheet).toContainText('reset --keep');
  await page.keyboard.press('End');
  await expect(mode.getByRole('radio', { name: 'Hard' })).toBeFocused();
  await expect(sheet).toContainText('reset --hard');
  // Tab leaves the group: its other choices are no stops of their own.
  await page.keyboard.press('Tab');
  await expect(mode.getByRole('radio', { name: 'Hard' })).not.toBeFocused();
  await expect(mode.locator(':focus')).toHaveCount(0);
});

test('a merge the branch already has reads as not possible, with nothing to choose', async ({ page }) => {
  const repo = copyDemo();
  await open(page, repo);
  // The menus leave such merges disabled where the graph shows HEAD (menus.spec); a view of
  // origin/main alone does not hold it, so there the sheet is what says so.
  await graphRow(page, 'Improve README').getByText('origin/main', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show only this branch' }).click();
  await graphRow(page, 'Improve README').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Merge/ }).click();
  const sheet = page.getByRole('dialog');
  // Named by the branch there, not by its hash.
  await expect(sheet.getByRole('heading', { name: 'Merge origin/main into main' })).toBeVisible();
  await expect(sheet.locator('[data-level="danger"]')).toContainText('main already contains origin/main');
  await expect(sheet.getByRole('radio', { name: 'Merge commit' })).toBeDisabled();
  await expect(sheet.getByRole('textbox', { name: 'Merge message' })).toBeDisabled();
  await expect(sheet.getByRole('button', { name: 'Not possible' })).toBeDisabled();
});

test('a rebase pull with nothing incoming yet says what may happen, not what will', async ({ page }) => {
  const repo = copyDemo();
  await open(page, repo);
  await page.getByRole('button', { name: 'Pull', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('If new commits come in, your 1 local commit is replayed on top of them');
  await expect(sheet).not.toContainText('Rewrites');
  await expect(sheet.getByRole('button', { name: 'Pull', exact: true })).toBeEnabled();
  await expect(sheet).toContainText('any new commits');
});

test('a revert that a staged file is in the way of carries the changes over; Undo puts all back', async ({
  page,
}) => {
  const repo = copyDemo();
  const status = git(repo, 'status', '--porcelain');
  await open(page, repo);
  await graphRow(page, 'Update dependencies').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Revert/ }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('1 staged file is in the way');
  await expect(sheet.getByRole('button', { name: 'Not possible' })).toBeDisabled();
  await sheet.getByRole('checkbox', { name: /Carry my uncommitted changes over/ }).check();
  await expect(sheet).toContainText("stash push -m 'lanefold: set aside for a revert'");
  await expect(sheet).toContainText('stash pop --index');
  await sheet.getByRole('button', { name: 'Revert', exact: true }).click();

  const toast = page.getByRole('status');
  await expect(toast).toContainText('Reverted “Update dependencies”');
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('Revert "Update dependencies"');
  expect(git(repo, 'status', '--porcelain')).toBe(status);
  expect(git(repo, 'stash', 'list')).toBe('');

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Undid “Revert ‘Update dependencies’”');
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('Add dark mode toggle');
  expect(git(repo, 'status', '--porcelain')).toBe(status);
});

test('checking out a commit says what detached HEAD means, and offers a branch there', async ({ page }) => {
  const repo = copyDemo();
  await open(page, repo);
  await graphRow(page, 'Update dependencies').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Check out this commit/ }).click();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Checked out “Update dependencies”');
  await expect(toast).toContainText('You’re not on a branch now: new commits won’t belong to one.');
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
  await toast.getByRole('button', { name: 'New branch here…' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('textbox', { name: 'Branch name' })).toBeFocused();
  await page.keyboard.type('dependencies');
  await page.keyboard.press('Enter');
  await expect(sheet).toBeHidden();
  expect(git(repo, 'branch', '--show-current')).toBe('dependencies');
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('Update dependencies');
});

test('a branch checked out in another worktree is opened there, not checked out or deleted here', async ({
  page,
}) => {
  const repo = copyDemo();
  const folder = join(dirname(repo), 'aurora-login');
  git(repo, 'worktree', 'add', '-q', folder, 'feature/login');
  await open(page, repo);
  const branches = page.getByRole('complementary', { name: 'Branches' });
  const sheet = page.getByRole('dialog');

  await branches.getByRole('treeitem', { name: 'login' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Delete branch/ }).click();
  await expect(sheet.locator('[data-level="danger"]')).toContainText(
    `feature/login is checked out in another worktree, ${folder}.`,
  );
  await expect(sheet.getByRole('button', { name: 'Not possible' })).toBeDisabled();
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();

  await branches.getByRole('treeitem', { name: 'login' }).click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: /^Check out/ })
    .first()
    .click();
  await expect(sheet.locator('[data-level="danger"]')).toContainText('checked out in another worktree');
  await sheet.getByRole('button', { name: 'Open its worktree' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: /^aurora-login/ })).toBeVisible();
  expect(git(repo, 'branch', '--show-current')).toBe('main');
  expect(git(repo, 'branch', '--list', 'feature/login')).toBe('+ feature/login');
});

test('confirmations say what was done; after Undo, Redo', async ({ page }) => {
  const repo = copyDemo();
  await open(page, repo);
  const branches = page.getByRole('complementary', { name: 'Branches' });
  await branches.getByRole('treeitem', { name: 'timezone' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Delete branch/ }).click();
  const toast = page.getByRole('status');
  await expect(toast).toContainText('Deleted branch hotfix/timezone');
  await expect(toast).toContainText('hotfix/timezone was at');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Undid “Delete branch hotfix/timezone”');
  expect(git(repo, 'branch', '--list', 'hotfix/timezone')).toBe('hotfix/timezone');
  await toast.getByRole('button', { name: 'Redo' }).click();
  await expect(toast).toContainText('Redid “Delete branch hotfix/timezone”');
  expect(git(repo, 'branch', '--list', 'hotfix/timezone')).toBe('');
});

test('a history edit stopped on a conflict: sides named, focus on the file, its abort named too', async ({
  page,
}) => {
  const repo = copyDemo({ stash: 'including untracked' });
  for (const [content, message] of [
    ['one', 'Add conf'],
    ['two', 'Change conf to two'],
    ['three', 'Change conf to three'],
  ] as const) {
    writeFileSync(join(repo, 'conf.txt'), `${content}\n`);
    git(repo, 'add', 'conf.txt');
    git(repo, 'commit', '-qm', message);
  }
  const head = git(repo, 'rev-parse', 'HEAD');
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Change conf to two').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: /Edit main from here/ }).click();
  // Dropping “two” leaves “three” to change a line it never had: a conflict.
  await planRow(page, 'Change conf to two').click();
  await page.keyboard.press('d');
  await historyEditor(page)
    .getByRole('button', { name: /^Apply/ })
    .click();

  await expect(banner(page)).toContainText('1 conflict');
  // The editor that started it is gone: focus goes to the file to resolve, not to the page.
  await expect(banner(page).getByRole('button', { name: 'conf.txt', exact: true })).toBeFocused();
  await expect(banner(page).getByRole('button', { name: 'Keep main' })).toBeVisible();
  await expect(banner(page).getByRole('button', { name: 'Use “Change conf to three”' })).toBeVisible();

  await banner(page).getByRole('button', { name: 'Abort' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Stop editing history' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Stop editing' }).click();
  await expect(banner(page)).toBeHidden();
  await expect(page.getByRole('status')).toContainText('Stopped editing history');
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
});

test('a commit taken apart puts committing a part first', async ({ page }) => {
  const repo = copyDemo({ stash: true });
  await open(page, repo);
  await graphRow(page, 'Update dependencies').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: /Split commit/ }).click();
  await historyEditor(page)
    .getByRole('button', { name: /^Apply/ })
    .click();
  await expect(banner(page)).toContainText('no part committed yet');
  // Continue would keep it whole: the first part comes first, and Continue is the quieter way.
  const commitPart = banner(page).getByRole('button', { name: 'Commit part 1…' });
  await expect(commitPart).toBeVisible();
  await commitPart.click();
  await expect(
    page.getByRole('form', { name: 'Commit' }).getByRole('textbox', { name: 'Commit message' }),
  ).toBeFocused();
});
