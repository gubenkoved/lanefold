import { expect, test, type Locator, type Page } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, debugUrl, git, graphRow, subjects } from './support';

test.use({ reducedMotion: 'reduce' });

async function open(page: Page, repo: string): Promise<void> {
  await page.goto(harnessUrl({ repo }));
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

/** The history editor, rebasing main onto `target`. */
const rebaseEditor = (page: Page, target: string): Locator =>
  page.getByRole('region', { name: `Rebase main onto ${target}` });

/** The editor's rows with their actions, newest first ("Pick: Add dark mode toggle"). */
const arrangement = (editor: Locator) =>
  editor
    .getByRole('option')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')!.split(' · ')[0]));

test('a branch’s menu rebases onto it with the commits arranged first, and Undo puts it back', async ({
  page,
}) => {
  const repo = copyDemo({ stash: true });
  const head = git(repo, 'rev-parse', 'HEAD');
  await open(page, repo);
  await graphRow(page, 'Show recent searches').getByText('feature/search', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rebase interactively…' }).click();

  const editor = rebaseEditor(page, 'feature/search');
  // The commits feature/search lacks, as they are: a plain rebase, ready to run.
  await expect
    .poll(() => arrangement(editor))
    .toEqual(['Pick: Add dark mode toggle', 'Pick: Improve README', 'Pick: Update dependencies']);
  await expect(editor.getByText('Replayed onto feature/search')).toBeVisible();
  await expect(editor.getByText('Applies cleanly')).toBeVisible();
  await expect(editor.getByRole('button', { name: /^Rebase/ })).toBeEnabled();

  // One of them is left behind.
  await editor.getByRole('option', { name: /^Pick: Improve README/ }).click();
  await page.keyboard.press('d');
  await expect(editor.getByRole('option', { name: /^Drop: Improve README/ })).toBeVisible();
  // The exact command is there to read before anything runs.
  await editor.getByRole('tab', { name: 'Git commands' }).click();
  await expect(editor).toContainText('--onto feature/search');
  await editor.getByRole('button', { name: /^Rebase/ }).click();

  await expect(editor).toBeHidden();
  expect(subjects(repo, 4)).toEqual([
    'Add dark mode toggle',
    'Update dependencies',
    'Show recent searches',
    'Debounce search requests',
  ]);
  expect(git(repo, 'branch', '--show-current')).toBe('main');
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => git(repo, 'rev-parse', 'HEAD')).toBe(head);
});

test('the review of a plain rebase leads to arranging the commits first', async ({ page }) => {
  const repo = copyDemo({ stash: true });
  await open(page, repo);
  await graphRow(page, 'Show recent searches').getByText('feature/search', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rebase main onto feature/search' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('Rebase main onto feature/search');
  await sheet.getByRole('button', { name: 'Arrange commits first…' }).click();

  await expect(sheet).toBeHidden();
  const editor = rebaseEditor(page, 'feature/search');
  await expect.poll(() => arrangement(editor)).toHaveLength(3);
  // Cancelled as it opened: nothing to discard, nothing changed.
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();
  expect(subjects(repo, 1)).toEqual(['Add dark mode toggle']);
});

test('the command opens the editor from any tab, with what the target already has left out', async ({
  page,
}) => {
  const repo = copyDemo({ stash: true });
  // The upstream took one of main's commits as a commit of its own.
  git(repo, 'checkout', '-q', '-b', 'rewritten', 'feature/search');
  git(repo, 'cherry-pick', git(repo, 'rev-parse', 'main~2'));
  git(repo, 'checkout', '-q', 'main');
  await open(page, repo);
  await page.request.get(debugUrl(page, 'command', { command: 'showStatistics' }));
  await expect(page.getByRole('tab', { name: 'Statistics', selected: true })).toBeVisible();

  const args = JSON.stringify({ repoId: repo, onto: 'rewritten' });
  await page.request.get(debugUrl(page, 'command', { command: 'startRebaseOnto', args }));
  const editor = rebaseEditor(page, 'rewritten');
  await expect
    .poll(() => arrangement(editor))
    .toEqual(['Pick: Add dark mode toggle', 'Pick: Improve README', 'Drop: Update dependencies']);
  await expect(
    editor.getByRole('option', { name: /^Drop: Update dependencies/ }).getByText('already in rewritten'),
  ).toBeVisible();
  await editor.getByRole('button', { name: /^Rebase/ }).click();

  await expect(editor).toBeHidden();
  expect(subjects(repo, 4)).toEqual([
    'Add dark mode toggle',
    'Improve README',
    'Update dependencies',
    'Show recent searches',
  ]);
  expect(git(repo, 'rev-parse', 'HEAD~2')).toBe(git(repo, 'rev-parse', 'rewritten'));
});

test('a branch that already contains the target edits the commits after it instead', async ({ page }) => {
  const repo = copyDemo({ stash: true });
  await open(page, repo);
  const args = JSON.stringify({ repoId: repo, onto: 'main~2' });
  await page.request.get(debugUrl(page, 'command', { command: 'startRebaseOnto', args }));
  const editor = page.getByRole('region', { name: 'Edit history of main' });
  await expect
    .poll(() => arrangement(editor))
    .toEqual(['Pick: Add dark mode toggle', 'Pick: Improve README']);
  await expect(page.getByText('main already contains main~2')).toBeVisible();
});
