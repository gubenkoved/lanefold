import { expect, test } from '@playwright/test';
import { harnessUrl } from './paths';
import { graphRow } from './support';

test.use({ viewport: { width: 1440, height: 520 } });

test('the branches pane reveals, filters and hides branches in the view', async ({ page }) => {
  await page.goto(harnessUrl());
  const pane = page.getByRole('complementary', { name: 'Branches' });
  const tree = pane.getByRole('tree');
  await expect(tree.getByRole('treeitem', { name: /^main/ }).first()).toBeVisible();

  // Clicking a branch selects its tip in the graph.
  await tree.getByRole('treeitem', { name: 'timezone' }).click();
  await expect(graphRow(page, 'Fix timezone offset in daily view')).toHaveAttribute('aria-selected', 'true');

  // The filter narrows the tree to matching refs, across sections.
  await pane.getByRole('textbox', { name: 'Filter branches and tags' }).fill('maps');
  await expect(tree.getByRole('treeitem', { name: 'experiment/maps' })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'review/maps' })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /timezone/ })).toHaveCount(0);

  // Unchecking both maps branches (a click on the checkbox, Space) takes their own commits out
  // of this view.
  const experiment = tree.getByRole('treeitem', { name: 'experiment/maps' });
  const review = tree.getByRole('treeitem', { name: 'review/maps' });
  await expect(graphRow(page, 'Try vector tiles')).toBeVisible();
  await expect(experiment).toHaveAttribute('aria-checked', 'true');
  await experiment.locator('[data-checked]').click();
  await expect(experiment).toHaveAttribute('aria-checked', 'false');
  // From the keyboard (without revealing the branch in the graph): the last row, Space.
  await tree.focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Space');
  await expect(review).toHaveAttribute('aria-checked', 'false');
  await expect(graphRow(page, 'Try vector tiles')).toBeHidden();
  await expect(graphRow(page, 'Prototype radar map layer')).toBeHidden();
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();

  // Shown again from the context menu.
  await experiment.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show in this view' }).click();
  await expect(graphRow(page, 'Try vector tiles')).toBeVisible();
  await expect(experiment).toHaveAttribute('aria-checked', 'true');
});

test('checkboxes add branches to the current branch, and to a view of one branch', async ({ page }) => {
  await page.goto(harnessUrl());
  await page.getByRole('tab', { name: 'main' }).click();
  const panel = page.getByRole('tabpanel', { name: 'main' });
  const pane = panel.getByRole('complementary', { name: 'Branches' });
  const tree = pane.getByRole('tree');
  const filter = pane.getByRole('textbox', { name: 'Filter branches and tags' });
  // The local branch comes first (its remote branch has the same name under origin); a row's
  // name goes on with its buttons while it has focus.
  const item = (name: string) => tree.getByRole('treeitem', { name: new RegExp(`^${name}`) }).first();
  const scope = panel.locator('button[title^="Branches this view shows"]');
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  await expect(graphRow(page, 'Show recent searches')).toBeHidden();
  // The branch checked out (one commit ahead of origin/main).
  await expect(item('main')).toHaveAttribute('aria-checked', 'true');

  // Checking a branch adds its commits; the view stays the current branch's.
  await filter.fill('search');
  await expect(item('feature/search')).toHaveAttribute('aria-checked', 'false');
  await item('feature/search').locator('[data-checked]').click();
  await expect(item('feature/search')).toHaveAttribute('aria-checked', 'true');
  await expect(graphRow(page, 'Show recent searches')).toBeVisible();
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  await expect(scope).toContainText('Current branch + feature/search');

  // Choosing a branch the view does not show offers to show it here.
  await filter.fill('maps');
  await item('experiment/maps').click();
  await page.getByRole('button', { name: 'Show it here' }).click();
  await expect(item('experiment/maps')).toHaveAttribute('aria-checked', 'true');
  await expect(graphRow(page, 'Try vector tiles')).toBeVisible();
  await expect(scope).toContainText('Current branch +2');

  // A view of one branch (its own tab) takes more next to it; its last one stays.
  await filter.fill('maps');
  await item('experiment/maps').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show only this branch' }).click();
  const maps = page.getByRole('tabpanel', { name: 'experiment/maps' });
  const mapsPane = maps.getByRole('complementary', { name: 'Branches' });
  const mapsItem = (name: string) =>
    mapsPane
      .getByRole('tree')
      .getByRole('treeitem', { name: new RegExp(`^${name}`) })
      .first();
  await expect(graphRow(page, 'Try vector tiles')).toBeVisible();
  await expect(graphRow(page, 'Add dark mode toggle')).toBeHidden();
  const mapsFilter = mapsPane.getByRole('textbox', { name: 'Filter branches and tags' });
  const mapsScope = maps.locator('button[title^="Branches this view shows"]');
  await mapsFilter.fill('search');
  await mapsItem('feature/search').locator('[data-checked]').click();
  await expect(mapsScope).toContainText('experiment/maps, feature/search');
  await expect(graphRow(page, 'Show recent searches')).toBeVisible();
  await mapsItem('feature/search').locator('[data-checked]').click();
  await expect(mapsScope).toContainText('experiment/maps');
  await expect(graphRow(page, 'Show recent searches')).toBeHidden();
  await mapsFilter.fill('maps');
  await expect(mapsItem('experiment/maps').locator('[data-checked]')).toHaveAttribute('data-fixed', 'true');
});

test('"New view" shows several branches together', async ({ page }) => {
  await page.goto(harnessUrl());
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /Several branches/ }).click();
  const picker = page.getByRole('dialog', { name: 'Branches to show' });
  for (const name of ['feature/search', 'experiment/maps']) {
    await picker.getByRole('combobox').fill(name);
    await picker
      .getByRole('option', { name: new RegExp(`^${name}`) })
      .first()
      .click();
  }
  await picker.getByRole('button', { name: 'Show' }).click();
  await expect(page.getByRole('tab', { name: 'feature/search +1' })).toHaveAttribute('aria-selected', 'true');
  await expect(graphRow(page, 'Show recent searches')).toBeVisible();
  await expect(graphRow(page, 'Try vector tiles')).toBeVisible();
  await expect(graphRow(page, 'Add dark mode toggle')).toBeHidden();
});

test('favorites collect at the top of the pane', async ({ page }) => {
  await page.goto(harnessUrl());
  const tree = page.getByRole('complementary', { name: 'Branches' }).getByRole('tree');
  const login = tree.getByRole('treeitem', { name: 'login' });
  await login.hover();
  await login.getByRole('button', { name: 'Add to favorites' }).click();
  await expect(tree.getByRole('treeitem', { name: /^Favorites/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'feature/login' })).toBeVisible();
});

test('where both do not fit beside the graph, the branches and details panes take turns', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 520 });
  await page.goto(harnessUrl());
  const branches = page.getByRole('complementary', { name: 'Branches' });
  const details = page.getByRole('complementary', { name: 'Commit details' });
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  await expect(details).toBeVisible();
  await expect(branches).toBeHidden();

  // The branches toggle stays: showing them puts the details pane away.
  await page.getByRole('button', { name: 'Show branches' }).click();
  await expect(branches.getByRole('tree')).toBeVisible();
  await expect(details).toBeHidden();
  await expect(page.getByRole('button', { name: 'Hide branches' })).toHaveAttribute('aria-pressed', 'true');

  // And the other way round.
  await page.getByRole('button', { name: 'Show details' }).click();
  await expect(details).toBeVisible();
  await expect(branches).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show branches' })).toHaveAttribute('aria-pressed', 'false');
});
