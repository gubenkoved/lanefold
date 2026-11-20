import { expect, test, type Locator, type Page } from '@playwright/test';
import { harnessUrl } from './paths';
import { graphRow } from './support';

// Wide enough for every column beside the branches and details panes.
test.use({ viewport: { width: 1600, height: 560 } });

async function open(page: Page): Promise<void> {
  await page.goto(harnessUrl());
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

const grid = (page: Page) => page.getByRole('tabpanel').getByRole('grid');
const heading = (page: Page, name: string) => grid(page).getByRole('columnheader', { name, exact: true });

/** The headings on screen, in DOM order, after checking that it is their order on screen too. */
async function headings(page: Page): Promise<string[]> {
  return inScreenOrder(grid(page).locator(':scope > [role="row"] > [role="columnheader"]'));
}

/**
 * The texts of the cells on screen, in DOM order, once their left edges are seen to follow that
 * order. Which are on screen is read along with where, in one go: as a graph settles into its
 * width, a cell found showing can be gone by the time it is measured.
 */
async function inScreenOrder(cells: Locator): Promise<string[]> {
  // The test project has no DOM types: what is used of them, typed as far as needed.
  type Cell = { getBoundingClientRect(): { left: number; width: number; height: number }; innerText: string };
  const read = await cells.evaluateAll((elements) =>
    (elements as unknown as Cell[])
      .map((cell) => ({ box: cell.getBoundingClientRect(), text: cell.innerText }))
      // A cell left out takes no room.
      .filter(({ box }) => box.width > 0 && box.height > 0)
      .map(({ box, text }) => ({ left: box.left, text })),
  );
  const lefts = read.map((cell) => cell.left);
  expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
  return read.map((cell) => cell.text.trim()).filter(Boolean);
}

async function dragHeading(page: Page, name: string, before: string): Promise<void> {
  const from = (await heading(page, name).boundingBox())!;
  const to = (await heading(page, before).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x - 10, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + 8, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('columns are switched off, moved from the menu, the keyboard or by dragging, in every graph', async ({
  page,
}) => {
  await open(page);
  expect(await headings(page)).toEqual(['COMMIT MESSAGE', 'AUTHOR', 'DATE', 'COMMIT']);

  // Off from the headings' menu: the heading and the rows' cells go.
  await heading(page, 'Author').click({ button: 'right' });
  await expect(page.getByRole('menuitemcheckbox', { name: 'Commit message' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.getByRole('menuitemcheckbox', { name: 'Author', checked: true }).click();
  await expect.poll(() => headings(page)).toEqual(['COMMIT MESSAGE', 'DATE', 'COMMIT']);
  await expect(graphRow(page, 'Update dependencies').getByText('Bob Builder')).toBeHidden();

  // Moved from the menu: the rows' cells follow, in the DOM too.
  await heading(page, 'Date').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move Date left' }).click();
  await expect.poll(() => headings(page)).toEqual(['DATE', 'COMMIT MESSAGE', 'COMMIT']);
  const cells = await inScreenOrder(graphRow(page, 'Update dependencies').getByRole('gridcell'));
  expect(cells).toEqual([
    expect.stringMatching(/2024/),
    'Update dependencies',
    expect.stringMatching(/^[0-9a-f]{8}$/),
  ]);

  // From the keyboard: Tab reaches the headings, the arrows move between them, Alt+arrows move one.
  await grid(page).focus();
  await page.keyboard.press('Tab');
  await expect(heading(page, 'Commit message')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(heading(page, 'Date')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(heading(page, 'Commit message')).toBeFocused();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => headings(page)).toEqual(['COMMIT MESSAGE', 'DATE', 'COMMIT']);
  await expect(heading(page, 'Commit message')).toBeFocused();
  // The menu from the keyboard, on the heading.
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Move Commit message right' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(heading(page, 'Commit message')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(grid(page)).toBeFocused();

  // Dragged: the hash goes first.
  await dragHeading(page, 'Commit', 'Commit message');
  await expect.poll(() => headings(page)).toEqual(['COMMIT', 'COMMIT MESSAGE', 'DATE']);

  // Every graph shows the same columns, and the view options switch them too.
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /Local branches/ }).click();
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  expect(await headings(page)).toEqual(['COMMIT', 'COMMIT MESSAGE', 'DATE']);
  await page.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Author', checked: false }).click();
  await expect.poll(() => headings(page)).toEqual(['COMMIT', 'COMMIT MESSAGE', 'DATE', 'AUTHOR']);

  // Kept for next time.
  await page.reload();
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  expect(await headings(page)).toEqual(['COMMIT', 'COMMIT MESSAGE', 'DATE', 'AUTHOR']);

  // And back to the usual columns.
  await heading(page, 'Date').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset columns' }).click();
  await expect.poll(() => headings(page)).toEqual(['COMMIT MESSAGE', 'AUTHOR', 'DATE', 'COMMIT']);
});

test('a narrow graph leaves out the hash and the author, and its menu says so', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 520 });
  await open(page);
  // The graph fits its columns to its width once it is measured, maybe after its rows show.
  await expect.poll(() => headings(page)).toEqual(['COMMIT MESSAGE', 'DATE']);
  await heading(page, 'Date').click({ button: 'right' });
  const hash = page.getByRole('menuitemcheckbox', { name: 'Commit hash', checked: true });
  await hash.hover();
  await expect(page.getByText('Shown when the graph is wider')).toBeVisible();
  await page.keyboard.press('Escape');

  // Wider, but not enough for the author beside the date: without the date, it fits.
  await page.setViewportSize({ width: 1180, height: 520 });
  await expect.poll(() => headings(page)).toEqual(['COMMIT MESSAGE', 'DATE']);
  await heading(page, 'Date').click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: 'Date' }).click();
  await expect.poll(() => headings(page)).toEqual(['COMMIT MESSAGE', 'AUTHOR']);
});

test('the counts of files and lines are off, and read from git only once switched on', async ({ page }) => {
  // What the page asks the host about commits' counts.
  const asked: { lines: boolean }[] = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', (frame) => {
      const text = String(frame.payload);
      if (text.includes('"log.stats"')) asked.push({ lines: /"lines":true/.test(text) });
    }),
  );
  await open(page);
  const row = graphRow(page, 'Add dark mode toggle');
  const cellsOf = (text: string) => inScreenOrder(graphRow(page, text).getByRole('gridcell'));

  // Off as they come: no heading, and nothing read.
  expect(await headings(page)).toEqual(['COMMIT MESSAGE', 'AUTHOR', 'DATE', 'COMMIT']);
  await heading(page, 'Date').click({ button: 'right' });
  await expect(page.getByRole('menuitemcheckbox', { name: 'Lines changed', checked: false })).toBeVisible();
  expect(asked).toEqual([]);

  // The files: their counts come in, and no lines are read for them.
  await page.getByRole('menuitemcheckbox', { name: 'Files changed', checked: false }).click();
  await expect.poll(() => headings(page)).toEqual(['COMMIT MESSAGE', 'AUTHOR', 'DATE', 'COMMIT', 'FILES']);
  await expect(row.getByRole('gridcell').last()).toHaveText('+1');
  expect((await cellsOf('Update dependencies')).at(-1)).toBe('~2');
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((request) => !request.lines)).toBe(true);
  // The exact counts, in words, on the cell.
  await row.getByRole('gridcell').last().hover();
  await expect(row.getByRole('gridcell').last()).toHaveAttribute('title', '1 file: 1 added');

  // The lines too.
  await page.getByRole('button', { name: 'View options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Lines changed', checked: false }).click();
  await page.keyboard.press('Escape');
  await expect
    .poll(() => headings(page))
    .toEqual(['COMMIT MESSAGE', 'AUTHOR', 'DATE', 'COMMIT', 'FILES', 'LINES']);
  await expect(row.getByRole('gridcell').last()).toHaveText('+1');
  await row.getByRole('gridcell').last().hover();
  await expect(row.getByRole('gridcell').last()).toHaveAttribute('title', '1 line added');
  expect(asked.some((request) => request.lines)).toBe(true);
  // A merge's counts are against its first parent, as its file list is.
  const merge = graphRow(page, "Merge branch 'feature/login'");
  await expect(merge.getByRole('gridcell').nth(-2)).toHaveText('+2');
  await merge.getByRole('gridcell').nth(-2).hover();
  await expect(merge.getByRole('gridcell').nth(-2)).toHaveAttribute(
    'title',
    '2 files: 2 added (against the first parent)',
  );
  // The uncommitted changes are no commit: they have none.
  expect((await cellsOf('Uncommitted changes')).at(-1)).toBe('now');

  // Kept for next time, and the usual columns leave them out again.
  await page.reload();
  await expect(row.getByRole('gridcell').last()).toHaveText('+1');
  await heading(page, 'Lines').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reset columns' }).click();
  await expect.poll(() => headings(page)).toEqual(['COMMIT MESSAGE', 'AUTHOR', 'DATE', 'COMMIT']);
});

test('a narrow graph leaves out the counts first, and reads none of them', async ({ page }) => {
  const asked: string[] = [];
  page.on('websocket', (socket) =>
    socket.on('framesent', (frame) => {
      const text = String(frame.payload);
      if (text.includes('"log.stats"')) asked.push(text);
    }),
  );
  await open(page);
  await heading(page, 'Date').click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: 'Lines changed', checked: false }).click();
  await expect.poll(() => headings(page)).toEqual(['COMMIT MESSAGE', 'AUTHOR', 'DATE', 'COMMIT', 'LINES']);
  await expect(graphRow(page, 'Add dark mode toggle').getByRole('gridcell').last()).toHaveText('+1');

  // Too narrow for them: the column goes, and a reloaded graph asks git nothing for it.
  await page.setViewportSize({ width: 760, height: 520 });
  await expect.poll(() => headings(page)).toEqual(['COMMIT MESSAGE', 'DATE']);
  asked.length = 0;
  await page.reload();
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  await expect.poll(() => headings(page)).toEqual(['COMMIT MESSAGE', 'DATE']);
  await heading(page, 'Date').click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: 'Lines changed', checked: true }).hover();
  await expect(page.getByText('Shown when the graph is wider')).toBeVisible();
  expect(asked).toEqual([]);
});
