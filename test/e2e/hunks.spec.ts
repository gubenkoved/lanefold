import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, gitRaw, graphRow, openedDiffs } from './support';

const FORECAST = 'src/forecast.ts';
const BASE_URL = "const BASE_URL = 'https://api.aurora.dev/v2';";
const TEMPERATURE = 'return `${Math.round(value)}°`;';

/** Edits a file of the copy (replacing text exactly once); returns the new content. */
function edit(repo: string, file: string, ...replacements: [string, string][]): string {
  let text = readFileSync(join(repo, file), 'utf8');
  for (const [from, to] of replacements) {
    expect(text.split(from)).toHaveLength(2);
    text = text.replace(from, to);
  }
  writeFileSync(join(repo, file), text);
  return text;
}

/** Two changes far apart: two hunks (2 + 1 changed lines at the top, 2 at the bottom). */
function twoHunks(repo: string): string {
  return edit(
    repo,
    FORECAST,
    [BASE_URL, "const BASE_URL = 'https://api.aurora.dev/v3';\nconst TIMEOUT_MS = 8000;"],
    [TEMPERATURE, 'return `${Math.round(value)}°C`;'],
  );
}

const THREE_LINES = "const TIMEOUT_MS = 8000;\nconst RETRIES = 3;\nconst USER_AGENT = 'aurora';";

/** Opens the repository with the uncommitted changes selected. */
async function openChanges(page: Page, repo: string) {
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Uncommitted changes').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  await expect(details.getByRole('heading', { name: 'Uncommitted changes' })).toBeVisible();
  return details;
}

/** A group of the uncommitted changes ("Staged", "Changes", "Untracked"). */
const group = (details: Locator, title: string) =>
  details.locator('section').filter({ has: details.page().locator(`header span:text-is("${title}")`) });

test('expands a file, stages one hunk, then the other: the file moves to Staged', async ({ page }) => {
  const repo = copyDemo();
  twoHunks(repo);
  const details = await openChanges(page, repo);
  const changes = group(details, 'Changes');
  await changes.getByRole('button', { name: 'Show changes in forecast.ts' }).click();
  await expect(changes.getByRole('listbox')).toHaveCount(2);
  await expect(changes.getByRole('option', { name: 'Added line 5: const TIMEOUT_MS = 8000;' })).toBeVisible();

  await changes.getByRole('button', { name: 'Stage hunk' }).first().click();
  await expect
    .poll(() => gitRaw(repo, 'diff', '--cached', '--', FORECAST))
    .toContain('+const TIMEOUT_MS = 8000;');
  const cached = gitRaw(repo, 'diff', '--cached', '--', FORECAST);
  expect(cached).toContain("+const BASE_URL = 'https://api.aurora.dev/v3';");
  expect(cached).not.toContain('°C');
  // Still expanded, with the hunk left to stage.
  await expect(changes.getByRole('listbox')).toHaveCount(1);
  await expect(changes.getByRole('button', { name: 'Hide changes in forecast.ts' })).toBeVisible();
  await expect(group(details, 'Staged').getByText('forecast.ts')).toBeVisible();

  await changes.getByRole('button', { name: 'Stage hunk' }).click();
  await expect.poll(() => gitRaw(repo, 'diff', '--', FORECAST)).toBe('');
  await expect(changes.getByText('forecast.ts')).toBeHidden();
  await expect(group(details, 'Staged').getByText('forecast.ts')).toBeVisible();
});

test('stages the lines picked with the mouse', async ({ page }) => {
  const repo = copyDemo();
  const original = readFileSync(join(repo, FORECAST), 'utf8');
  edit(repo, FORECAST, [BASE_URL, `${BASE_URL}\n${THREE_LINES}`]);
  const details = await openChanges(page, repo);
  const changes = group(details, 'Changes');
  await changes.getByRole('button', { name: 'Show changes in forecast.ts' }).click();

  await changes.getByRole('option', { name: /^Added line 5:/ }).click();
  await changes.getByRole('option', { name: /^Added line 6:/ }).click({ modifiers: ['Shift'] });
  await expect(changes.getByRole('option', { selected: true })).toHaveCount(2);
  // Context lines are not picked (they are disabled options: the click is forced).
  await changes.getByRole('option', { name: /^Line 3:/ }).click({ force: true });
  await expect(changes.getByRole('option', { selected: true })).toHaveCount(2);
  await changes.getByRole('button', { name: 'Stage 2 lines' }).click();

  const expected = original.replace(BASE_URL, `${BASE_URL}\nconst TIMEOUT_MS = 8000;\nconst RETRIES = 3;`);
  await expect.poll(() => gitRaw(repo, 'show', `:${FORECAST}`)).toBe(expected);
  expect(gitRaw(repo, 'diff', '--cached', '--', FORECAST)).not.toContain('USER_AGENT');
  // What is left to stage: the third line; nothing is picked any more.
  await expect(changes.getByRole('option', { name: /^Added line \d+: const USER_AGENT/ })).toBeVisible();
  await expect(changes.getByRole('option', { selected: true })).toHaveCount(0);
  await expect(changes.getByRole('button', { name: 'Stage hunk' })).toBeVisible();
});

test('picks lines by dragging, adds and removes them with Ctrl+click, and Esc clears', async ({ page }) => {
  const repo = copyDemo();
  edit(repo, FORECAST, [BASE_URL, `${BASE_URL}\n${THREE_LINES}`]);
  const details = await openChanges(page, repo);
  const changes = group(details, 'Changes');
  await changes.getByRole('button', { name: 'Show changes in forecast.ts' }).click();
  const line = (n: number) => changes.getByRole('option', { name: new RegExp(`^Added line ${n}:`) });

  // The mouse does not scroll: bring the lines into view first.
  await line(7).scrollIntoViewIfNeeded();
  await line(5).scrollIntoViewIfNeeded();
  const from = (await line(5).boundingBox())!;
  const to = (await line(7).boundingBox())!;
  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(changes.getByRole('option', { selected: true })).toHaveCount(3);
  await expect(changes.getByText('3 lines selected')).toBeVisible();

  await line(6).click({ modifiers: ['ControlOrMeta'] });
  await expect(line(6)).toHaveAttribute('aria-selected', 'false');
  await expect(changes.getByRole('button', { name: 'Stage 2 lines' })).toBeVisible();
  await expect(changes.getByRole('button', { name: 'Discard 2 lines…' })).toBeVisible();
  await line(6).click({ modifiers: ['ControlOrMeta'] });
  await expect(changes.getByRole('option', { selected: true })).toHaveCount(3);

  await page.keyboard.press('Escape');
  await expect(changes.getByRole('option', { selected: true })).toHaveCount(0);
  await expect(changes.getByRole('button', { name: 'Stage hunk' })).toBeVisible();
  expect(gitRaw(repo, 'diff', '--cached', '--', FORECAST)).toBe('');
});

test('unstages a line from the Staged group with the keyboard', async ({ page }) => {
  const repo = copyDemo();
  const original = readFileSync(join(repo, FORECAST), 'utf8');
  const edited = edit(repo, FORECAST, [BASE_URL, `${BASE_URL}\n${THREE_LINES}`]);
  gitRaw(repo, 'add', FORECAST);
  const details = await openChanges(page, repo);
  const staged = group(details, 'Staged');

  // → on the file's row shows its diff.
  await staged.locator(`button[title="${FORECAST}"]`).focus();
  await page.keyboard.press('ArrowRight');
  const lines = staged.getByRole('listbox');
  await expect(lines).toHaveCount(1);
  await lines.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(staged.getByRole('option', { name: /^Added line 6: const RETRIES/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // The hunk's actions come right before its lines.
  await page.keyboard.press('Shift+Tab');
  await expect(staged.getByRole('button', { name: 'Unstage 1 line' })).toBeFocused();
  await page.keyboard.press('Enter');

  const expected = original.replace(
    BASE_URL,
    `${BASE_URL}\nconst TIMEOUT_MS = 8000;\nconst USER_AGENT = 'aurora';`,
  );
  await expect.poll(() => gitRaw(repo, 'show', `:${FORECAST}`)).toBe(expected);
  expect(readFileSync(join(repo, FORECAST), 'utf8')).toBe(edited);
  expect(gitRaw(repo, 'diff', '--', FORECAST)).toContain('+const RETRIES = 3;');
  // Focus stays in the diff for the next line.
  await expect(staged.getByRole('listbox')).toBeFocused();
});

test('discards a hunk after review, and Undo brings it back exactly', async ({ page }) => {
  const repo = copyDemo();
  const edited = twoHunks(repo);
  const details = await openChanges(page, repo);
  const changes = group(details, 'Changes');
  await changes.getByRole('button', { name: 'Show changes in forecast.ts' }).click();
  await changes.getByRole('button', { name: 'Discard hunk…' }).nth(1).click();

  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Discard 2 lines in forecast.ts' })).toBeVisible();
  await expect(sheet).toContainText('Take 2 changed lines out of src/forecast.ts on disk');
  await expect(sheet).toContainText('apply --reverse --whitespace=nowarn');
  await expect(sheet).toContainText('Lanefold builds the patch from the selected lines');
  await expect(sheet).toContainText('Undo brings them back');
  await sheet.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(sheet).toBeHidden();

  await expect.poll(() => readFileSync(join(repo, FORECAST), 'utf8')).not.toContain('°C');
  const now = readFileSync(join(repo, FORECAST), 'utf8');
  expect(now).toContain('const TIMEOUT_MS = 8000;');
  expect(now).toContain(TEMPERATURE);
  await expect(changes.getByRole('listbox')).toHaveCount(1);

  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => readFileSync(join(repo, FORECAST), 'utf8')).toBe(edited);
  await expect(changes.getByRole('listbox')).toHaveCount(2);
});

test('shows a note for a binary file, with the diff editor a click away', async ({ page }) => {
  const repo = copyDemo();
  writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255]));
  const details = await openChanges(page, repo);
  const untracked = group(details, 'Untracked');
  await untracked.getByRole('button', { name: 'Show changes in logo.png' }).click();
  await expect(untracked).toContainText('A binary file: its changes cannot be shown here.');
  await expect(untracked).toContainText('It can only be staged or deleted as a whole.');
  await expect(untracked.getByRole('listbox')).toHaveCount(0);
  await untracked.getByRole('button', { name: 'Open in diff editor' }).click();
  await expect
    .poll(async () => (await openedDiffs(page)).map((diff) => diff.right))
    .toContain('WORKTREE:logo.png');
});

test('a double click stages one hunk, quietly: the buttons wait for the new diff', async ({ page }) => {
  const repo = copyDemo();
  twoHunks(repo);
  const details = await openChanges(page, repo);
  const changes = group(details, 'Changes');
  await changes.getByRole('button', { name: 'Show changes in forecast.ts' }).click();
  await changes.getByRole('button', { name: 'Stage hunk' }).first().dblclick();
  await expect(changes.getByRole('listbox')).toHaveCount(1);
  const cached = gitRaw(repo, 'diff', '--cached', '--', FORECAST);
  expect(cached).toContain('+const TIMEOUT_MS = 8000;');
  expect(cached).not.toContain('°C');
  await expect(page.getByText('Could not stage')).toHaveCount(0);
});

test('shows the whitespace of lines that differ in whitespace only', async ({ page }) => {
  const repo = copyDemo();
  edit(
    repo,
    FORECAST,
    ['  if (cached) return cached;', '  if (cached) return cached;  '],
    [TEMPERATURE, 'return `${Math.round(value)}°C`;'],
  );
  const details = await openChanges(page, repo);
  const changes = group(details, 'Changes');
  await changes.getByRole('button', { name: 'Show changes in forecast.ts' }).click();
  // Trailing spaces added: shown on both sides of the change, as the editor shows whitespace.
  await expect(changes.getByRole('option', { name: /^Added line 23:/ })).toContainText(
    '··if (cached) return cached;··',
  );
  await expect(changes.getByRole('option', { name: /^Removed line 23:/ })).toContainText(
    '··if (cached) return cached;',
  );
  // A change of the text itself shows the text alone.
  await expect(changes.getByRole('option', { name: /^Added line 34:/ })).not.toContainText('·');
});
