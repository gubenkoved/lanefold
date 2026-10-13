import { expect, test } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, git, graphRow } from './support';

for (const theme of ['dark-modern', 'light-modern', 'dark-hc']) {
  test(`shell renders the repository, views and console (${theme})`, async ({ page }, testInfo) => {
    await page.goto(harnessUrl({ theme }));

    // Repository chip shows the repo and its checked-out branch.
    const chip = page.getByRole('button', { name: /aurora/ });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('main');

    // Default views plus the console.
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');

    // The console lists the commands the backend ran to load the repository.
    await page.getByRole('tab', { name: /Console/ }).click();
    await page.getByRole('button', { name: /All commands/ }).click();
    const symbolicRef = page.getByRole('button', { name: /symbolic-ref/ }).first();
    await expect(symbolicRef).toBeVisible();
    await symbolicRef.click();
    await expect(page.getByRole('button', { name: 'Copy command' })).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath(`shell-${theme}.png`) });
  });
}

test('views can be added, reordered by keyboard and closed', async ({ page }) => {
  await page.goto(harnessUrl());
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /Local branches/ }).click();
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(4);
  const local = page.getByRole('tab', { name: /Local/ });
  await expect(local).toHaveAttribute('aria-selected', 'true');

  // Alt+Left moves the focused tab.
  await local.focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(tabs.nth(1)).toContainText('Local');

  await page.keyboard.press('Delete');
  await expect(tabs).toHaveCount(3);
});

test('views are named after what they show, and no two tabs are alike', async ({ page }) => {
  const repo = copyDemo({ stash: true });
  await page.goto(harnessUrl({ repo }));
  const tabs = page.getByRole('tab');
  // The current branch's view is named after the branch.
  await expect(tabs).toHaveText(['All', 'main', 'Console']);

  // Asking for a view that is open shows that one.
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /Current branch/ }).click();
  await expect(tabs).toHaveText(['All', 'main', 'Console']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');

  // A copy is numbered.
  await tabs.nth(0).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(tabs).toHaveText(['All', 'main', 'All 2', 'Console']);

  // The name follows the branch checked out.
  git(repo, 'checkout', '-q', 'feature/login');
  await expect(tabs.nth(1)).toHaveText('feature/login');
});

test('pickers work from the keyboard: typing filters, Enter chooses, Escape gives focus back', async ({
  page,
}) => {
  await page.goto(harnessUrl());
  await graphRow(page, 'Update dependencies').click();
  const newView = page.getByRole('button', { name: 'New view' });
  await newView.click();
  await page.getByRole('menuitem', { name: /Branch or tag/ }).click();
  const picker = page.getByRole('dialog', { name: 'Show history of' });
  const search = picker.getByRole('combobox');
  await expect(search).toBeFocused();
  // Escape closes it, and focus goes back to what opened it.
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(newView).toBeFocused();

  // Escape closes it wherever focus is, before the view there sees the key (the graph would
  // drop its selection).
  await newView.click();
  await page.getByRole('menuitem', { name: /Branch or tag/ }).click();
  await expect(search).toBeFocused();
  await page.getByRole('tabpanel').getByRole('grid').focus();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(graphRow(page, 'Update dependencies')).toHaveAttribute('aria-selected', 'true');

  await newView.click();
  await page.getByRole('menuitem', { name: /Branch or tag/ }).click();
  await expect(search).toBeFocused();
  await page.keyboard.type('login');
  await expect(picker.getByRole('option').first()).toHaveText(/^feature\/login/);
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(page.getByRole('tab', { name: 'feature/login' })).toHaveAttribute('aria-selected', 'true');
});

test('a comparison is set up from the keyboard', async ({ page }) => {
  await page.goto(harnessUrl());
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /Compare branches/ }).click();

  // The side still to choose has focus: Enter opens its list, Escape comes back to it.
  const to = page.getByRole('button', { name: 'Compare to: Choose…' });
  await expect(to).toBeFocused();
  await page.keyboard.press('Enter');
  const picker = page.getByRole('dialog', { name: 'Compare to' });
  await expect(picker.getByRole('combobox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(to).toBeFocused();

  await page.keyboard.press('Enter');
  await page.keyboard.type('feature/search');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'main ↔ feature/search' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Compare to: feature/search' })).toBeFocused();

  // What is compared is one Tab stop: the arrow keys change it.
  const kinds = page.getByRole('radiogroup', { name: 'Comparison' });
  await kinds.getByRole('radio', { name: 'Since common ancestor' }).focus();
  await page.keyboard.press('ArrowRight');
  const direct = kinds.getByRole('radio', { name: 'Direct difference' });
  await expect(direct).toBeFocused();
  await expect(direct).toHaveAttribute('aria-checked', 'true');
});

test('a toast stays clear of the commit box, so committing again is in reach', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 700 });
  await page.goto(harnessUrl({ repo: copyDemo() }));
  await graphRow(page, 'Uncommitted changes').click();
  const box = page.getByRole('form', { name: 'Commit' });
  await box.getByRole('textbox', { name: 'Commit message' }).fill('Add notes');
  await box.getByRole('textbox', { name: 'Commit message' }).press('Control+Enter');
  const status = page.getByRole('status');
  await expect(status.getByRole('button', { name: 'Undo' })).toBeVisible();
  const toast = status.locator(':scope > *').first();
  await expect
    .poll(async () => {
      const [over, under] = await Promise.all([toast.boundingBox(), box.boundingBox()]);
      return !!over && !!under && over.y + over.height <= under.y;
    })
    .toBe(true);
});

test('the app never scrolls as a whole', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto(harnessUrl());
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  // Something a few pixels past the window's edge (a splitter's grip did) let focus shift it all.
  const scrolled = await page.locator('#root').evaluate((root) => {
    root.scrollTop = 50;
    root.scrollLeft = 50;
    return root.scrollTop + root.scrollLeft + root.closest('html')!.scrollTop;
  });
  expect(scrolled).toBe(0);
});
