import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, debugUrl, git, graphRow, historyEditor, planRow, subjects } from './support';

async function open(page: Page, repo: string): Promise<void> {
  await page.goto(harnessUrl({ repo }));
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

test('squashes two selected commits with a combined message, then undoes it', async ({ page }) => {
  const repo = copyDemo();
  const head = git(repo, 'rev-parse', 'HEAD');
  await open(page, repo);
  await graphRow(page, 'Update dependencies').click();
  await graphRow(page, 'Improve README').click({ modifiers: ['Control'] });
  await graphRow(page, 'Improve README').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Squash 2 commits/ }).click();

  await expect(historyEditor(page)).toContainText('3 commits');
  await expect(planRow(page, 'Improve README')).toContainText('Squash');
  // The message editor opens with both messages, the first line selected.
  const message = historyEditor(page).getByRole('textbox', { name: 'Commit message' });
  await expect(message).toHaveValue('Update dependencies\n\nImprove README');
  await message.fill('Update dependencies and the README');
  await expect(historyEditor(page).getByText('Applies cleanly')).toBeVisible();
  await historyEditor(page)
    .getByRole('button', { name: /^Apply/ })
    .click();

  await expect(historyEditor(page)).toBeHidden();
  expect(subjects(repo, 3)).toEqual([
    'Add dark mode toggle',
    'Update dependencies and the README',
    'Polish dashboard layout',
  ]);
  // Uncommitted changes were set aside and restored.
  expect(git(repo, 'status', '--porcelain')).toContain('NOTES.md');
  // The graph follows: the new commit is selected and shown in the details.
  await expect(page.getByRole('complementary', { name: 'Commit details' })).toContainText(
    'Update dependencies and the README',
  );

  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => git(repo, 'rev-parse', 'HEAD')).toBe(head);
});

test('Ctrl+Enter right after typing a message applies it as typed, once its plan is ready', async ({
  page,
}) => {
  const repo = copyDemo({ stash: true });
  await open(page, repo);
  await graphRow(page, 'Add dark mode toggle').click();
  await page.keyboard.press('F2');
  const message = historyEditor(page).getByRole('textbox', { name: 'Commit message' });
  await expect(message).toBeFocused();
  // Typed and applied at once: the plan of the new message is still on its way, and the Apply
  // waits for it rather than being dropped.
  await page.keyboard.type('Dark mode, at last');
  await page.keyboard.press('Control+Enter');
  await expect(historyEditor(page)).toBeHidden();
  expect(subjects(repo, 1)).toEqual(['Dark mode, at last']);
  // The keys are with the graph again.
  await expect(page.getByRole('tabpanel').getByRole('grid')).toBeFocused();
});

test('while the editor is open, git’s Undo waits: Ctrl+Z steps back the arrangement only', async ({
  page,
}) => {
  const repo = copyDemo({ stash: true });
  await open(page, repo);
  /** Opens the editor on main's commits after the one `back` from HEAD (found by its hash). */
  const editFrom = async (back: number, subject: string) => {
    await graphRow(page, git(repo, 'rev-parse', '--short=8', `HEAD~${back}`)).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit history' }).hover();
    await page.getByRole('menuitem', { name: /Edit main from here/ }).click();
    await expect(planRow(page, subject)).toHaveAttribute('aria-selected', 'true');
  };
  const focus = async () =>
    (await (await page.request.get(debugUrl(page, 'focus'))).json()) as {
      focused: boolean;
      graphFocused: boolean;
    } | null;
  // An operation to undo: an edit, applied.
  await editFrom(2, 'Update dependencies');
  await planRow(page, 'Improve README').click();
  await page.keyboard.press('d');
  await expect(historyEditor(page).getByText('Applies cleanly')).toBeVisible();
  await page.keyboard.press('Control+Enter');
  await expect(historyEditor(page)).toBeHidden();
  const head = git(repo, 'rev-parse', 'HEAD');
  const undo = page.getByRole('button', { name: /^Undo: Edit history of main/ });
  await expect(undo).toBeEnabled();
  // Let the graph's reload settle before using its menus (a right-click on a row that moves lands
  // on another commit). Main alone has recent commits, so a slow reload shows main's new history
  // first and the other branches' after: origin/main's “Improve README” is back.
  await expect(graphRow(page, 'Add dark mode toggle')).toContainText(head.slice(0, 8));
  await expect(graphRow(page, 'Improve README')).toBeVisible();

  // Editing again (the graph shows the new history): the top bar's Undo waits for the edit to be
  // applied or cancelled.
  await editFrom(1, 'Update dependencies');
  await planRow(page, 'Add dark mode toggle').click();
  await page.keyboard.press('d');
  await expect(undo).toBeDisabled();
  await expect(undo).toHaveAccessibleName(/paused while you edit history/);
  // A click where nothing takes focus (a result card) keeps Ctrl+Z with the editor: it steps
  // back the arrangement, never the operation.
  await historyEditor(page).getByRole('complementary', { name: 'Result' }).getByText('Bob Builder').click();
  await page.keyboard.press('Control+z');
  await expect(planRow(page, 'Add dark mode toggle')).toContainText('Pick');
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  // Nor does VS Code send Ctrl+Z to git's Undo while the editor shows, wherever focus is.
  await page.getByRole('button', { name: 'Refresh' }).focus();
  await expect.poll(focus).toEqual({ focused: true, graphFocused: false });
  // Undo and Redo from the command palette step through the arrangement too.
  const run = (command: string) => page.request.get(debugUrl(page, 'command', { command }));
  await run('redo');
  await expect(planRow(page, 'Add dark mode toggle')).toContainText('Drop');
  await run('undo');
  await expect(planRow(page, 'Add dark mode toggle')).toContainText('Pick');
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);

  // Closed, the editor gives the keys back to the graph, and Undo is git's again.
  await historyEditor(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(historyEditor(page)).toBeHidden();
  await expect(undo).toBeEnabled();
  await expect.poll(focus).toEqual({ focused: true, graphFocused: true });
});

test('reorders and drops with the keyboard, showing the exact todo', async ({ page }) => {
  const repo = copyDemo();
  await open(page, repo);
  await graphRow(page, 'Polish dashboard layout').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: /Edit main from here/ }).click();
  await expect(historyEditor(page)).toContainText('4 commits');

  // Newest first: move "Improve README" down below "Update dependencies", drop "Polish".
  await planRow(page, 'Improve README').click();
  await page.keyboard.press('Alt+ArrowDown');
  await planRow(page, 'Polish dashboard layout').click();
  await page.keyboard.press('d');
  await expect(planRow(page, 'Polish dashboard layout')).toContainText('Drop');

  await historyEditor(page).getByRole('tab', { name: 'Git commands' }).click();
  const todo = historyEditor(page).locator('pre');
  await expect(todo).toContainText(/pick [0-9a-f]+\npick [0-9a-f]+\npick [0-9a-f]+\ndrop [0-9a-f]+/);
  await expect(historyEditor(page)).toContainText('git rebase -i --no-autosquash');

  await page.keyboard.press('Control+Enter');
  await expect(historyEditor(page)).toBeHidden();
  expect(subjects(repo, 4)).toEqual([
    'Add dark mode toggle',
    'Update dependencies',
    'Improve README',
    "Merge branch 'hotfix/timezone'",
  ]);
});

test('amends an earlier commit with the staged changes, from its menu or by dragging them onto it', async ({
  page,
}) => {
  const repo = copyDemo();
  const head = git(repo, 'rev-parse', 'HEAD');
  await open(page, repo);
  await graphRow(page, 'Update dependencies').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Amend with the staged changes…' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('git commit -m');
  await expect(sheet).toContainText('rebase -i --autosquash');
  await sheet.getByRole('button', { name: 'Amend', exact: true }).click();

  // The staged file went into "Update dependencies"; every message stays; unstaged changes too.
  await expect.poll(() => git(repo, 'show', '--name-only', '--format=', 'HEAD~2')).toContain('NOTES.md');
  expect(subjects(repo, 3)).toEqual(['Add dark mode toggle', 'Improve README', 'Update dependencies']);
  // Git moves the branch a moment before it puts the set-aside changes back.
  await expect.poll(() => git(repo, 'status', '--porcelain')).toBe('M src/dashboard.css');
  // Undo once the graph shows the amended history (the history Undo puts back looks like the one
  // before the amend, and origin/main keeps the old “Improve README” on screen meanwhile).
  const amended = graphRow(page, git(repo, 'rev-parse', 'HEAD~1').slice(0, 8));
  await expect(amended).toBeVisible();
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => git(repo, 'rev-parse', 'HEAD')).toBe(head);
  await expect.poll(() => git(repo, 'status', '--porcelain')).toBe('A  NOTES.md\n M src/dashboard.css');

  // Dragged onto a commit, the uncommitted changes offer the same (once the graph shows the
  // history Undo put back: a drop on a commit it replaced has nothing to amend).
  await expect(amended).toBeHidden();
  await expect(graphRow(page, 'Improve README')).toContainText('1c1a40e3');
  const changes = graphRow(page, 'Uncommitted changes');
  await expect(changes).toContainText('1 staged');
  await changes.click();
  await expect(changes).toHaveAttribute('aria-selected', 'true');
  const from = (await changes.boundingBox())!;
  const to = (await graphRow(page, 'Improve README').boundingBox())!;
  await page.mouse.move(from.x + 200, from.y + from.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 6; step++)
    await page.mouse.move(from.x + 200, from.y + from.height / 2 + ((to.y - from.y) * step) / 6);
  await page.mouse.up();
  await page.getByRole('menuitem', { name: 'Amend “Improve README” with the staged changes…' }).click();
  await expect(page.getByRole('dialog')).toContainText('Amend');
  await expect(page.getByRole('dialog')).toContainText('fixup!');
});

test('stops at a commit to amend it, then continues from the banner', async ({ page }) => {
  const repo = copyDemo({ stash: true });
  await open(page, repo);
  await graphRow(page, 'Update dependencies').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: /Stop here to amend/ }).click();
  await expect(planRow(page, 'Update dependencies')).toContainText('Edit');
  await historyEditor(page)
    .getByRole('button', { name: /^Apply/ })
    .click();

  const banner = page.getByRole('region', { name: 'Operation in progress' });
  await expect(banner).toContainText('Stopped to edit');
  writeFileSync(join(repo, 'CHANGELOG.md'), readFileSync(join(repo, 'README.md'), 'utf8'));
  git(repo, 'add', 'CHANGELOG.md');
  await expect(banner.getByRole('button', { name: 'Amend & continue' })).toBeVisible();
  await banner.getByRole('button', { name: 'Amend & continue' }).click();

  await expect(banner).toBeHidden();
  expect(subjects(repo, 3)).toEqual(['Add dark mode toggle', 'Improve README', 'Update dependencies']);
  expect(git(repo, 'show', '--name-only', '--format=', 'HEAD~2')).toContain('CHANGELOG.md');
  // One Undo reverts the whole edit, stop included.
  await page.getByRole('button', { name: 'Undo: Edit history of main' }).click();
  await expect.poll(() => git(repo, 'log', '-1', '--format=%s', 'HEAD~2')).toBe('Update dependencies');
  await expect.poll(() => git(repo, 'ls-files', 'CHANGELOG.md')).toBe('');
});

test('rewording in a short bottom panel shows the whole message box, ready to type', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 320 });
  await page.goto(harnessUrl());
  await graphRow(page, 'Improve README').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Reword/ }).click();
  const message = historyEditor(page).getByRole('textbox', { name: 'Commit message' });
  await expect(message).toBeFocused();
  // Below the fold at first: the box and its buttons are scrolled into view.
  await expect(message).toBeInViewport({ ratio: 1 });
  await expect(historyEditor(page).getByRole('button', { name: 'Done' })).toBeInViewport({ ratio: 1 });
});
