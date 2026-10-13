import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { lowContrast } from './contrast';
import { fixtureDir, harnessUrl } from './paths';
import { copyDemo, git, graphRow, historyEditor, subjects } from './support';

/** A small repository whose middle commit (by Bob) changes both ends of one file: two hunks. */
function twoHunkRepo(): string {
  const repo = join(fixtureDir('split'), 'notes');
  mkdirSync(repo, { recursive: true });
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  const write = () => writeFileSync(join(repo, 'notes.txt'), `${lines.join('\n')}\n`);
  git(repo, 'init', '-q', '--initial-branch=main');
  write();
  git(repo, 'add', 'notes.txt');
  git(repo, 'commit', '-q', '-m', 'Write the notes');
  lines[0] = 'line 1, reworded';
  lines[11] = 'line 12, reworded';
  write();
  git(
    repo,
    '-c',
    'user.name=Bob Builder',
    '-c',
    'user.email=bob@example.com',
    'commit',
    '-q',
    '-am',
    'Reword both ends',
  );
  writeFileSync(join(repo, 'README.md'), '# Notes\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'Add a README');
  return repo;
}

const banner = (page: Page) => page.getByRole('region', { name: 'Operation in progress' });

async function open(page: Page, repo: string): Promise<void> {
  await page.goto(harnessUrl({ repo }));
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

test('splits a commit from the graph: one part committed from the details pane, the rest on Continue; Undo restores it', async ({
  page,
}) => {
  const repo = copyDemo({ stash: true });
  const head = git(repo, 'rev-parse', 'HEAD');
  await open(page, repo);
  await graphRow(page, 'Update dependencies').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: /Split commit/ }).click();

  await expect(historyEditor(page).getByRole('option', { name: /Update dependencies/ })).toContainText(
    'Split',
  );
  await expect(historyEditor(page)).toContainText('splits into parts');
  await historyEditor(page)
    .getByRole('button', { name: /^Apply/ })
    .click();

  // Git stopped there and Lanefold took the commit apart: its changes are uncommitted.
  await expect(banner(page)).toContainText('Splitting');
  await expect(banner(page)).toContainText('Update dependencies');
  await expect(banner(page)).toContainText('Its changes are uncommitted now');
  expect(git(repo, 'diff', '--name-only')).toBe('package.json\nsrc/forecast.ts');
  expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');

  // Stage one file and commit it as the first part, starting from the original message.
  await graphRow(page, 'Uncommitted changes').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  const file = details.getByRole('listitem').filter({ hasText: 'package.json' }).first();
  await file.hover();
  await file.getByRole('button', { name: 'Stage' }).click();
  await expect.poll(() => git(repo, 'diff', '--cached', '--name-only')).toBe('package.json');
  const box = details.getByRole('form', { name: 'Commit' });
  await expect(box).toContainText('Part 1 of');
  await box.getByRole('button', { name: 'Original message' }).click();
  const message = box.getByRole('textbox', { name: 'Commit message' });
  await expect(message).toHaveValue('Update dependencies');
  await message.fill('Bump the version');
  await message.press('Control+Enter');
  await expect(banner(page)).toContainText('1 part committed');
  await expect(banner(page).getByRole('list', { name: 'Parts committed so far' })).toContainText(
    'Bump the version',
  );

  // Continue commits what is left as the original commit and finishes the edit.
  await banner(page).getByRole('button', { name: 'Continue' }).click();
  await expect(banner(page)).toBeHidden();
  expect(subjects(repo, 4)).toEqual([
    'Add dark mode toggle',
    'Improve README',
    'Update dependencies',
    'Bump the version',
  ]);
  expect(git(repo, 'show', '--name-only', '--format=', 'HEAD~3')).toBe('package.json');
  expect(git(repo, 'show', '--name-only', '--format=', 'HEAD~2')).toBe('src/forecast.ts');
  expect(git(repo, 'log', '-1', '--format=%an', 'HEAD~2')).toBe('Bob Builder');
  expect(git(repo, 'status', '--porcelain')).toBe('');

  // One Undo reverts the whole edit, split included.
  await page.getByRole('button', { name: 'Undo: Edit history of main' }).click();
  await expect.poll(() => git(repo, 'rev-parse', 'HEAD')).toBe(head);
});

test('a split reached from a terminal waits for the Split button in the banner', async ({ page }) => {
  const repo = copyDemo({ stash: true });
  const updateDependencies = git(repo, 'rev-parse', 'HEAD~2');
  await open(page, repo);
  await graphRow(page, 'Polish dashboard layout').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: /Edit main from here/ }).click();
  for (const subject of ['Update dependencies', 'Improve README']) {
    const row = historyEditor(page).getByRole('option', { name: new RegExp(subject) });
    await row.click();
    await page.keyboard.press('i');
    await expect(row).toContainText('Split');
  }
  await expect(historyEditor(page)).toContainText('Stops at each of');
  await historyEditor(page)
    .getByRole('button', { name: /^Apply/ })
    .click();
  await expect(banner(page)).toContainText('Its changes are uncommitted now');

  // Finished by hand in a terminal: git goes on to the next commit to split, which stays whole.
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-C', updateDependencies);
  git(repo, 'rebase', '--continue');
  await page.reload();
  await expect(banner(page)).toContainText('Stopped to split');
  await expect(banner(page)).toContainText('It is still whole');
  expect(git(repo, 'status', '--porcelain')).toBe('');

  await banner(page).getByRole('button', { name: 'Split', exact: true }).click();
  await expect(banner(page)).toContainText('Its changes are uncommitted now');
  expect(git(repo, 'diff', '--name-only')).toBe('README.md');
  // Nothing committed as a part: Continue (after a review that says so) puts it back whole, and
  // the edit finishes.
  await banner(page).getByRole('button', { name: 'Continue' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('No part is committed yet');
  await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(banner(page)).toBeHidden();
  expect(subjects(repo, 3)).toEqual(['Add dark mode toggle', 'Improve README', 'Update dependencies']);
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

test('marks a commit to split with its key and shows the edit stop in the todo', async ({ page }) => {
  const repo = copyDemo({ stash: true });
  await open(page, repo);
  await graphRow(page, 'Polish dashboard layout').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: /Edit main from here/ }).click();

  const row = historyEditor(page).getByRole('option', { name: /Update dependencies/ });
  await row.click();
  await page.keyboard.press('i');
  await expect(row).toContainText('Split');
  await expect(
    historyEditor(page).getByRole('toolbar').getByRole('button', { name: /Split/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await historyEditor(page).getByRole('tab', { name: 'Git commands' }).click();
  await expect(historyEditor(page).locator('pre')).toContainText(
    /pick [0-9a-f]+\nedit [0-9a-f]+\npick [0-9a-f]+/,
  );
  await expect(historyEditor(page)).toContainText(
    'with its changes uncommitted so you can commit them in parts',
  );
  // Nothing ran yet.
  await historyEditor(page).getByRole('button', { name: 'Cancel' }).click();
  await historyEditor(page).getByRole('button', { name: 'Discard' }).click();
  await expect(historyEditor(page)).toBeHidden();
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

test('splits one file’s changes into two commits, a hunk at a time', async ({ page }) => {
  const repo = twoHunkRepo();
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Reword both ends').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: /Split commit/ }).click();
  await historyEditor(page)
    .getByRole('button', { name: /^Apply/ })
    .click();
  await expect(banner(page)).toContainText('Its changes are uncommitted now');

  // Its changes come into view by themselves; the first hunk becomes a commit of its own.
  const details = page.getByRole('complementary', { name: 'Commit details' });
  await expect(details.getByRole('heading', { name: 'Uncommitted changes' })).toBeVisible();
  await details.getByRole('button', { name: 'Show changes in notes.txt' }).click();
  await expect(details.getByRole('listbox')).toHaveCount(2);
  await details.getByRole('button', { name: 'Stage hunk' }).first().click();
  const message = details
    .getByRole('form', { name: 'Commit' })
    .getByRole('textbox', { name: 'Commit message' });
  await message.fill('Reword the first line');
  await message.press('Control+Enter');
  await expect(banner(page)).toContainText('1 part committed');
  // What is left stays in view: the other hunk.
  await expect(details.getByRole('listbox')).toHaveCount(1);
  await expect(details.getByRole('option', { name: /line 12, reworded/ })).toBeVisible();

  // Continue: the rest is the original commit, by its author.
  await banner(page).getByRole('button', { name: 'Continue' }).click();
  await expect(banner(page)).toBeHidden();
  expect(subjects(repo, 4)).toEqual([
    'Add a README',
    'Reword both ends',
    'Reword the first line',
    'Write the notes',
  ]);
  const part = git(repo, 'show', 'HEAD~2:notes.txt').split('\n');
  expect([part[0], part[11]]).toEqual(['line 1, reworded', 'line 12']);
  const rest = git(repo, 'show', 'HEAD~1:notes.txt').split('\n');
  expect([rest[0], rest[11]]).toEqual(['line 1, reworded', 'line 12, reworded']);
  expect(git(repo, 'log', '-1', '--format=%an', 'HEAD~1')).toBe('Bob Builder');
  expect(git(repo, 'status', '--porcelain')).toBe('');
});

for (const theme of ['dark-modern', 'light-modern', 'dark-hc', 'light-hc']) {
  test(`the split banner and the commit box read at 4.5:1 or more (${theme})`, async ({ page }) => {
    const repo = twoHunkRepo();
    await page.goto(harnessUrl({ repo, theme }));
    await graphRow(page, 'Reword both ends').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit history' }).hover();
    await page.getByRole('menuitem', { name: /Split commit/ }).click();
    await historyEditor(page)
      .getByRole('button', { name: /^Apply/ })
      .click();
    await graphRow(page, 'Uncommitted changes').click();
    const details = page.getByRole('complementary', { name: 'Commit details' });
    await details.getByRole('button', { name: 'Show changes in notes.txt' }).click();
    await details.getByRole('button', { name: 'Stage hunk' }).first().click();
    const box = details.getByRole('form', { name: 'Commit' });
    await box.getByRole('textbox', { name: 'Commit message' }).fill('Reword the first line');
    await box.getByRole('textbox', { name: 'Commit message' }).press('Control+Enter');
    await expect(banner(page)).toContainText('1 part committed');
    expect(await lowContrast(banner(page))).toEqual([]);
    expect(await lowContrast(box)).toEqual([]);
  });
}
