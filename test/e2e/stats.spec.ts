import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DEMO_REPO, harnessUrl } from './paths';
import { copyDemo, debugUrl, git, graphRow } from './support';

async function openStats(page: Page, repo = DEMO_REPO) {
  await page.goto(harnessUrl({ repo }));
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /Statistics/ }).click();
  await expect(page.getByRole('tab', { name: /Statistics/ })).toHaveAttribute('aria-selected', 'true');
  return page.getByRole('tabpanel', { name: 'Statistics' });
}

/** A summary tile, by its label. */
const tile = (page: Page, label: string) =>
  page.locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) });

const contributors = (page: Page) => page.getByRole('listbox', { name: 'Contributors' });

/** The log search's box: its text is the match count. */
const searchStatus = (page: Page) =>
  page.getByRole('textbox', { name: /Search commits/ }).locator('xpath=..');

test('Statistics opens from "New view" and sums up the history', async ({ page }) => {
  const view = await openStats(page);
  await expect(tile(page, 'Commits')).toContainText('15');
  await expect(tile(page, 'Commits')).toContainText('2 merges');
  await expect(tile(page, 'Contributors')).toContainText('4');
  // Lines are counted in the background: the numbers follow.
  await expect(tile(page, 'Lines added')).toContainText('+55');
  await expect(tile(page, 'Lines removed')).toContainText('−7');
  await expect(tile(page, 'Files changed')).toContainText('12');
  await expect(tile(page, 'Active days')).toContainText('15');
  await expect(tile(page, 'First → last commit')).toContainText('5 months');
  await expect(tile(page, 'Typical commit')).toContainText('2 lines');

  const options = contributors(page).getByRole('option');
  await expect(options).toHaveCount(4);
  await expect(options.first()).toContainText('Alice Archer');
  await expect(
    view.getByRole('listbox', { name: 'Files changed most often' }).getByRole('option').first(),
  ).toContainText('forecast.ts');
  await expect(view.getByRole('list', { name: 'Languages' })).toContainText('TypeScript');

  // There is one Statistics tab: choosing it again shows that one.
  await page.getByRole('tab', { name: /Console/ }).click();
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /Statistics/ }).click();
  await expect(page.getByRole('tab', { name: /Statistics/ })).toHaveCount(1);
  await expect(page.getByRole('tab', { name: /Statistics/ })).toHaveAttribute('aria-selected', 'true');

  // All branches: the two open branches' five commits too.
  await view.getByRole('radio', { name: 'All branches' }).click();
  await expect(tile(page, 'Commits')).toContainText('20');

  // A bar of the activity chart opens that week's commits in the log.
  await view.getByRole('radio', { name: 'Current branch' }).click();
  await expect(tile(page, 'Commits')).toContainText('15');
  await view
    .getByRole('group', { name: 'Commits per week' })
    .getByRole('button', { name: /^Week of Jan 1, 2024: 2 commits/ })
    .click();
  await expect(page.getByRole('tab', { name: 'Week of Jan 1, 2024' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('textbox', { name: /Search commits/ })).toHaveValue(
    'after:"2024-01-01 00:00:00" before:"2024-01-07 23:59:59"',
  );
  await expect(searchStatus(page)).toHaveText('2');
});

test('filters to an author and back; their commits open in the log', async ({ page }) => {
  const view = await openStats(page);
  await contributors(page)
    .getByRole('option', { name: /^Carol Chen/ })
    .click();
  const chip = view.getByRole('button', { name: /Show every author/ });
  await expect(chip).toBeVisible();
  const about = view.getByRole('region', { name: 'About Carol Chen' });
  await expect(about).toContainText('4 commits (27%)');
  await expect(about).toContainText('Feb 2 – Jun 10, 2024');
  await expect(tile(page, 'Commits')).toContainText('4');
  await expect(tile(page, 'Share')).toContainText('27%');
  // Every contributor stays listed; Carol is the one shown.
  await expect(contributors(page).getByRole('option')).toHaveCount(4);
  await expect(contributors(page).getByRole('option', { name: /^Carol Chen/ })).toHaveAttribute(
    'aria-current',
    'true',
  );

  // The filter is saved with the tab.
  await page.reload();
  await expect(page.getByRole('region', { name: 'About Carol Chen' })).toBeVisible();

  await page.getByRole('button', { name: 'Show commits' }).click();
  await expect(page.getByRole('tab', { name: 'Carol Chen' })).toHaveAttribute('aria-selected', 'true');
  const search = page.getByRole('textbox', { name: /Search commits/ });
  await expect(search).toHaveValue('author:"Carol Chen"');
  await expect(searchStatus(page)).toHaveText('4');

  await page.getByRole('tab', { name: /Statistics/ }).click();
  await page.getByRole('button', { name: /Show every author/ }).click();
  await expect(page.getByRole('region', { name: /^About/ })).toHaveCount(0);
  await expect(tile(page, 'Commits')).toContainText('15');
});

test('ranges count recent commits only, and follow new ones', async ({ page }) => {
  const repo = copyDemo();
  const view = await openStats(page, repo);
  await expect(tile(page, 'Commits')).toContainText('15');
  // The demo's history ends in 2024.
  await view.getByRole('radio', { name: '30 days' }).click();
  await expect(view.getByRole('heading', { name: 'No commits in the last 30 days.' })).toBeVisible();

  writeFileSync(join(repo, 'today.txt'), 'one\ntwo\n');
  git(repo, 'add', 'today.txt');
  git(
    repo,
    '-c',
    'user.name=Erin Example',
    '-c',
    'user.email=erin@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'Work done today',
    // The demo has other changes staged: they stay out of it.
    '--',
    'today.txt',
  );
  await expect(tile(page, 'Commits')).toContainText('1');
  await expect(tile(page, 'Lines added')).toContainText('+2');
  await expect(contributors(page).getByRole('option')).toHaveCount(1);
  await expect(contributors(page)).toContainText('Erin Example');

  await view.getByRole('radio', { name: 'All time' }).click();
  await expect(tile(page, 'Commits')).toContainText('16');
  await expect(contributors(page).getByRole('option')).toHaveCount(5);
});

test('lists keep their columns whatever the numbers: large ones short, whole on hover', async ({ page }) => {
  const repo = copyDemo();
  // Erin writes a large file, then removes most of it: numbers far wider than anyone else's.
  for (const [lines, message] of [
    [150_000, 'Generate a large file'],
    [10_000, 'Trim the large file'],
  ] as const) {
    writeFileSync(join(repo, 'generated.txt'), 'line\n'.repeat(lines));
    git(repo, 'add', 'generated.txt');
    git(
      repo,
      '-c',
      'user.name=Erin Example',
      '-c',
      'user.email=erin@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      message,
      // The demo has other changes staged: they stay out of it.
      '--',
      'generated.txt',
    );
  }
  await openStats(page, repo);
  const erin = contributors(page).getByRole('option', { name: /^Erin Example/ });
  await expect(erin).toHaveAccessibleName(/150,000 lines added, 140,000 removed/);
  const added = erin.getByText('+150K');
  await expect(added).toBeVisible();
  await expect(added).toHaveAttribute('title', '+150,000 −140,000 lines');
  await expect(erin.getByText('−140K')).toBeVisible();

  // Every row's bar starts and ends where the others' do, under the heading's.
  const bars = await contributors(page)
    .getByRole('option')
    .evaluateAll((rows) =>
      rows.map((row) => {
        const bar = row.children[2]!.getBoundingClientRect();
        return `${Math.round(bar.left)}:${Math.round(bar.width)}`;
      }),
    );
  expect(bars).toHaveLength(5);
  expect(new Set(bars).size).toBe(1);
  const heading = await contributors(page).evaluate(
    (list) => list.previousElementSibling!.children[1]!.getBoundingClientRect().left,
  );
  expect(Math.round(heading)).toBe(Number(bars[0]!.split(':')[0]));
});

test('fits a narrow panel', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 800 });
  const view = await openStats(page);
  await expect(tile(page, 'Commits')).toContainText('15');
  // Nothing moves while the lines are counted: the toolbar's progress keeps its place.
  const shown = await tile(page, 'Commits').boundingBox();
  await expect(tile(page, 'Lines added')).toContainText('+55');
  expect(await tile(page, 'Commits').boundingBox()).toEqual(shown);
  // Two tiles a row.
  const [first, second, third] = await Promise.all(
    ['Commits', 'Contributors', 'Lines added'].map((label) => tile(page, label).boundingBox()),
  );
  expect(Math.abs(first!.y - second!.y)).toBeLessThan(2);
  expect(third!.y).toBeGreaterThan(first!.y + first!.height);
  // Nothing wider than the panel.
  const boxes = await Promise.all(
    (await view.locator('section, dl > div, [role="radiogroup"]').all()).map((element) =>
      element.boundingBox(),
    ),
  );
  expect(boxes.length).toBeGreaterThan(10);
  for (const box of boxes) {
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(520);
  }
  await expect(contributors(page).getByRole('option').first()).toBeVisible();
});

test('a commit’s author opens the statistics filtered to them', async ({ page }) => {
  await page.goto(harnessUrl());
  await graphRow(page, 'Add dark mode toggle').click();
  await page
    .getByRole('complementary', { name: 'Commit details' })
    .getByRole('button', { name: 'Statistics for Carol Chen' })
    .click();
  await expect(page.getByRole('tab', { name: /Statistics/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'About Carol Chen' })).toContainText('4 commits');
});

test('works from the keyboard', async ({ page }) => {
  const view = await openStats(page);
  await expect(tile(page, 'Commits')).toContainText('15');

  // A choice of ranges is one tab stop: arrows move the choice.
  const ranges = view.getByRole('radiogroup', { name: 'Time range' });
  await ranges.getByRole('radio', { name: 'All time' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(ranges.getByRole('radio', { name: '12 months' })).toBeFocused();
  await expect(ranges.getByRole('radio', { name: '12 months' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Home');
  await expect(ranges.getByRole('radio', { name: 'All time' })).toHaveAttribute('aria-checked', 'true');
  await expect(tile(page, 'Commits')).toContainText('15');

  // The chart is one tab stop too, at the newest period; its numbers show on focus.
  const bars = view.getByRole('group', { name: 'Commits per week' }).getByRole('button');
  await expect(bars).toHaveCount(24);
  await expect(bars.last()).toHaveAttribute('tabindex', '0');
  await bars.last().focus();
  await page.keyboard.press('ArrowLeft');
  await expect(bars.nth(22)).toBeFocused();
  await expect(view.getByText('Week of Jun 3, 2024')).toBeVisible();

  // Lists: arrows move, Enter chooses.
  const list = contributors(page);
  await list.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(view.getByRole('region', { name: 'About Carol Chen' })).toBeVisible();
});

test('the Show Statistics command opens the view, or brings it back', async ({ page, request }) => {
  await page.goto(harnessUrl());
  // The tabs show once the page is connected: the host can send it commands.
  await expect(page.getByRole('tab').first()).toBeVisible();
  const command = () => request.get(debugUrl(page, 'command', { command: 'showStatistics' }));
  expect((await command()).status()).toBe(204);
  const tab = page.getByRole('tab', { name: /Statistics/ });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(tile(page, 'Commits')).toContainText('15');

  // Again from another tab: the same tab comes back, no second one.
  await page.getByRole('tab').first().click();
  await expect(tab).toHaveAttribute('aria-selected', 'false');
  expect((await command()).status()).toBe(204);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(tab).toHaveCount(1);
});
