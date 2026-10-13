import { expect, test, type Page } from '@playwright/test';
import { harnessUrl } from './paths';
import { debugUrl, graphRow, graphRows, historyEditor, openedDiffs } from './support';

async function open(page: Page): Promise<void> {
  await page.goto(harnessUrl());
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

test('the graph shows history, details and opens diffs', async ({ page }) => {
  await open(page);
  // The uncommitted-changes row sits on top of HEAD.
  await expect(graphRow(page, 'Uncommitted changes')).toContainText('1 staged');

  await graphRow(page, 'Update dependencies').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  await expect(details.getByRole('heading', { name: 'Update dependencies' })).toBeVisible();
  await expect(details).toContainText('Bob Builder');
  await details.getByRole('button', { name: /package\.json/ }).click();
  await expect
    .poll(async () => (await openedDiffs(page)).map((d) => d.title))
    .toContainEqual(expect.stringContaining('package.json'));

  await details.getByRole('button', { name: /Open all/ }).click();
  await expect
    .poll(async () => (await openedDiffs(page)).some((d) => d.files?.includes('package.json')))
    .toBe(true);
});

test('two selected commits compare; a range shows its combined changes', async ({ page }) => {
  await open(page);
  const details = page.getByRole('complementary', { name: 'Commit details' });

  await graphRow(page, 'Add city search box').click();
  await graphRow(page, 'Show recent searches').click({ modifiers: ['ControlOrMeta'] });
  await expect(details).toContainText('Comparing two commits');
  await expect(details.getByRole('button', { name: /recent\.ts/ })).toBeVisible();
  await expect(details.getByRole('button', { name: /search\.tsx/ })).toBeVisible();

  // Shift-click extends to a range of one line of history: combined changes.
  await graphRow(page, 'Debounce search requests').click({ modifiers: ['Shift'] });
  await graphRow(page, 'Show recent searches').click();
  await graphRow(page, 'Add city search box').click({ modifiers: ['Shift'] });
  await expect(details).toContainText('3 commits selected');
  await expect(details).toContainText('One line of history');
  await expect(details.getByRole('button', { name: /recent\.ts/ })).toBeVisible();
});

test('search highlights matches and can filter the graph down to them', async ({ page }) => {
  await open(page);
  const search = page.getByRole('textbox', { name: /Search commits/ });
  await search.fill('search');
  await expect(page.getByText(/^3$/)).toBeVisible();

  await page.getByRole('radio', { name: /Filter/ }).click();
  await expect(graphRows(page)).toHaveCount(3);
  await expect(graphRows(page).and(page.locator('[data-row="0"]'))).toContainText('Show recent searches');

  // Author shorthand.
  await search.fill('@dubois');
  await expect(graphRows(page)).toHaveCount(3);
  await expect(graphRow(page, 'Try vector tiles')).toBeVisible();
});

test('a branch pill opens a comparison with the current branch', async ({ page }) => {
  await open(page);
  await graphRow(page, 'Show recent searches').getByText('feature/search', { exact: true }).click();
  await page.getByRole('menuitem', { name: /Compare with main/ }).click();
  await expect(page.getByRole('tab', { name: /main ↔ feature\/search/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const panel = page.getByRole('tabpanel', { name: /main ↔ feature\/search/ });
  await expect(panel).toContainText('Only in feature/search');
  await expect(panel.getByRole('button', { name: /recent\.ts/ })).toBeVisible();
});

test('the commit menu opens the history from a commit in a new tab', async ({ page }) => {
  await open(page);
  await graphRow(page, 'Polish dashboard layout').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Show history from here/ }).click();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(graphRow(page, 'Polish dashboard layout')).toBeVisible();
  // History from that commit: later commits are not in this view.
  await expect(page.getByRole('tabpanel')).not.toContainText('Add dark mode toggle');
});

test('menus work from the keyboard: arrows move, Escape closes and gives focus back', async ({ page }) => {
  await open(page);
  await graphRow(page, 'Polish dashboard layout').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.locator('[data-active="true"]')).toHaveCount(1);

  // Escape closes only the menu: the graph keeps its selection and gets focus back.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  const grid = page.getByRole('tabpanel').getByRole('grid');
  await expect(grid).toBeFocused();
  await expect(graphRow(page, 'Polish dashboard layout')).toHaveAttribute('aria-selected', 'true');

  // Shift+F10 (or the menu key) opens the same menu at the selected commit.
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('Ctrl+Z stays with text boxes and the history editor: only the graph lets it undo git', async ({
  page,
  request,
}) => {
  await open(page);
  const focus = async () => {
    const response = await request.get(debugUrl(page, 'focus'));
    return (await response.json()) as { focused: boolean; graphFocused: boolean } | null;
  };
  await graphRow(page, 'Update dependencies').click();
  await expect.poll(focus).toEqual({ focused: true, graphFocused: true });

  await page.getByRole('textbox', { name: /Search commits/ }).click();
  await expect.poll(focus).toEqual({ focused: true, graphFocused: false });

  // The history editor has an undo of its own.
  await graphRow(page, 'Update dependencies').click();
  await expect.poll(focus).toEqual({ focused: true, graphFocused: true });
  await graphRow(page, 'Improve README').click({ modifiers: ['ControlOrMeta'] });
  await graphRow(page, 'Improve README').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Squash 2 commits/ }).click();
  await historyEditor(page)
    .getByRole('listbox', { name: 'Commits, newest first' })
    .getByText('Add dark mode toggle')
    .click();
  await expect.poll(focus).toEqual({ focused: true, graphFocused: false });
});
