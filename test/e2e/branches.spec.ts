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

  // Hiding both maps branches takes their own commits out of this view.
  await expect(graphRow(page, 'Try vector tiles')).toBeVisible();
  for (const name of ['experiment/maps', 'review/maps']) {
    await tree.getByRole('treeitem', { name }).hover();
    await tree.getByRole('treeitem', { name }).getByRole('button', { name: 'Hide in this view' }).click();
  }
  await expect(graphRow(page, 'Try vector tiles')).toBeHidden();
  await expect(graphRow(page, 'Prototype radar map layer')).toBeHidden();
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();

  // Shown again from the context menu.
  await tree.getByRole('treeitem', { name: 'experiment/maps' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show in this view' }).click();
  await expect(graphRow(page, 'Try vector tiles')).toBeVisible();
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
