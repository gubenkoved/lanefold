import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fixtureDir, harnessUrl } from './paths';
import { graphRow, graphRows } from './support';

async function open(page: Page, repo?: string): Promise<void> {
  await page.goto(harnessUrl(repo ? { repo } : {}));
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
}

/** A new repository without commits: one untracked file in it, or nothing at all. */
function newRepository(file: boolean): string {
  const repo = join(fixtureDir('logview'), 'fresh');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  if (file) writeFileSync(join(repo, 'README.md'), '# Fresh\n');
  return repo;
}

const searchBox = (page: Page) => page.getByRole('textbox', { name: /Search commits/ });
const details = (page: Page) => page.getByRole('complementary', { name: 'Commit details' });

test('filtering counts every match and says how many of the commits it shows', async ({ page }) => {
  await open(page);
  await page.getByRole('radio', { name: 'Filter' }).click();
  await searchBox(page).fill('search');
  await expect(graphRows(page)).toHaveCount(3);
  const status = page.locator('label').filter({ has: searchBox(page) });
  await expect(status).toContainText('3');
  await expect(status).not.toContainText('No results');
  await expect(page.getByText('3 of 20 commits')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next match' })).toBeEnabled();
  // Stepping goes through every match.
  await page.getByRole('button', { name: 'Next match' }).click();
  await expect(status).toContainText('1 of 3');
  await page.getByRole('button', { name: 'Previous match' }).click();
  await page.getByRole('button', { name: 'Previous match' }).click();
  await expect(status).toContainText('2 of 3');

  // Highlighting, the toolbar counts the view's commits again.
  await page.getByRole('radio', { name: 'Highlight' }).click();
  await expect(page.getByText('20 commits', { exact: true })).toBeVisible();
});

test('a filter that matches nothing says so and offers the ways back', async ({ page }) => {
  await open(page);
  await page.getByRole('radio', { name: 'Filter' }).click();
  await searchBox(page).fill('zzzz-nothing');
  const graph = page.getByRole('tabpanel').getByRole('grid');
  await expect(graph).toContainText('No commits match ‘zzzz-nothing’');
  await expect(graph).not.toContainText('Nothing this view shows has commits');
  await graph.getByRole('button', { name: 'Switch to Highlight' }).click();
  await expect(page.getByRole('radio', { name: 'Highlight' })).toHaveAttribute('aria-checked', 'true');
  await expect(graphRow(page, 'Update dependencies')).toBeVisible();

  await page.getByRole('radio', { name: 'Filter' }).click();
  await graph.getByRole('button', { name: 'Clear search' }).click();
  await expect(searchBox(page)).toHaveValue('');
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
});

test('the search tips are reached with Tab and put their operator in the box', async ({ page }) => {
  await open(page);
  await searchBox(page).focus();
  const tips = page.getByRole('group', { name: 'Search operators' });
  await expect(tips).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(tips.getByRole('button', { name: /author/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(tips.getByRole('button', { name: /hash/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(searchBox(page)).toBeFocused();
  await expect(searchBox(page)).toHaveValue('#');

  // Past the last tip, Tab goes on to the toolbar (not to the page).
  await searchBox(page).fill('');
  await searchBox(page).focus();
  for (let i = 0; i < 7; i++) await page.keyboard.press('Tab');
  await expect(page.getByRole('radio', { name: 'Highlight' })).toBeFocused();
  await expect(tips).toBeHidden();
});

test('scrollbar markers show only while the graph scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  const markers = page.getByRole('tabpanel').locator('canvas[class*="markers"]');
  await expect(markers).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 420 });
  await expect(markers).toBeVisible();
});

test('dragging is told about: the help lists it, the uncommitted changes row says it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page);
  await expect(details(page).getByText('Drag Uncommitted changes')).toBeVisible();
  await expect(details(page).getByText('Amend a commit with them')).toBeVisible();
  await expect(details(page).getByText('Drag a branch pill')).toBeVisible();
  await expect(graphRow(page, 'Uncommitted changes')).toHaveAttribute('title', /drag it onto a commit/);
});

test('file buttons name their file', async ({ page }) => {
  await open(page);
  await graphRow(page, 'Uncommitted changes').click();
  const pane = details(page);
  await expect(pane.getByRole('button', { name: 'Unstage NOTES.md', exact: true })).toBeAttached();
  await expect(pane.getByRole('button', { name: 'Stage src/dashboard.css', exact: true })).toBeAttached();
  await expect(
    pane.getByRole('button', { name: 'Discard changes to src/dashboard.css…', exact: true }),
  ).toBeAttached();
});

test.describe('in a narrow view', () => {
  test.use({ viewport: { width: 520, height: 700 } });

  test('the file lists stay reachable above the commit box', async ({ page }) => {
    await open(page);
    await graphRow(page, 'Uncommitted changes').click();
    const pane = details(page);
    const file = pane.getByRole('listitem').filter({ hasText: 'dashboard.css' }).first();
    await file.scrollIntoViewIfNeeded();
    await expect(file).toBeInViewport({ ratio: 1 });
    // Nothing covers it: the commit box is not over the lists.
    const box = pane.getByRole('form', { name: 'Commit' });
    const [fileBox, formBox] = [(await file.boundingBox())!, (await box.boundingBox())!];
    expect(fileBox.y + fileBox.height <= formBox.y || formBox.y + formBox.height <= fileBox.y).toBe(true);
    // Writing a message brings the whole box into view, its button too.
    await box.getByRole('textbox', { name: 'Commit message' }).click();
    await expect(box.getByRole('button', { name: /^Commit/ }).first()).toBeInViewport({ ratio: 1 });
  });

  test('with nothing selected the details take one line; the scope keeps its name', async ({ page }) => {
    await open(page);
    const pane = details(page);
    await expect(pane).toContainText('Select a commit to see its changes.');
    expect((await pane.boundingBox())!.height).toBeLessThan(60);
    await expect(page.getByRole('button', { name: 'All branches' })).toBeVisible();
    // A selection opens the pane to its size.
    await graphRow(page, 'Update dependencies').click();
    await expect(pane.getByRole('heading', { name: 'Update dependencies' })).toBeVisible();
    expect((await pane.boundingBox())!.height).toBeGreaterThan(150);
  });
});

test('a repository without commits shows its uncommitted changes, ready for the first commit', async ({
  page,
}) => {
  await page.goto(harnessUrl({ repo: newRepository(true) }));
  await expect(details(page).getByRole('heading', { name: 'Uncommitted changes' })).toBeVisible();
  await expect(details(page)).toContainText('No commits yet on main');
  await expect(details(page).getByRole('button', { name: 'Stage README.md', exact: true })).toBeAttached();

  await page.goto(harnessUrl({ repo: newRepository(false) }));
  await expect(details(page).getByRole('heading', { name: 'No commits yet' })).toBeVisible();
  await expect(details(page)).toContainText('Add files, stage them and make the first commit.');
  await expect(details(page)).not.toContainText('Select a commit');
});

test('F2 on a commit the history editor cannot reach says why', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await graphRow(page, 'Debounce search requests').click();
  await page.keyboard.press('F2');
  await expect(
    page.getByRole('status').filter({ hasText: 'Check out feature/search to edit it' }),
  ).toBeVisible();
});

test('a filtered view keeps the colors of the whole history', async ({ page }) => {
  await open(page);
  // A pill takes its commit's lane color (`--c` in its style).
  const pillStyle = () =>
    graphRow(page, 'Improve README')
      .getByText('origin/main', { exact: true })
      .locator('..')
      .getAttribute('style');
  const style = await pillStyle();
  expect(style).toContain('--c:');
  await page.getByRole('radio', { name: 'Filter' }).click();
  await searchBox(page).fill('README');
  await expect(graphRows(page)).toHaveCount(1);
  await expect.poll(pillStyle).toBe(style);
});
