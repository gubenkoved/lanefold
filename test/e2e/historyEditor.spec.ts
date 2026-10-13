import { expect, test, type Locator, type Page } from '@playwright/test';
import { lowContrast } from './contrast';
import { harnessUrl } from './paths';
import { copyDemo, graphRow, historyEditor, planRow } from './support';

// Rows glide to where a change puts them, unless motion is reduced: then they are at once where
// a drag measures them.
test.use({ reducedMotion: 'reduce' });

/** Opens the history editor on the last four commits of main (Polish dashboard layout selected). */
async function openEditor(page: Page, theme = 'dark-modern'): Promise<void> {
  await page.goto(harnessUrl({ repo: copyDemo({ stash: true }), theme }));
  await graphRow(page, 'Polish dashboard layout').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: /Edit main from here/ }).click();
  await expect(planRow(page, 'Polish dashboard layout')).toHaveAttribute('aria-selected', 'true');
}

/** Presses on a row and sends keys to the list in one go, before anything renders in between. */
async function clickThenKeys(row: Locator, ...keys: string[]): Promise<void> {
  await row.evaluate((element, pressed) => {
    // The test project has no DOM types: the page's own event classes, typed as far as needed.
    const page = globalThis as unknown as {
      PointerEvent: new (type: string, init: object) => unknown;
      KeyboardEvent: new (type: string, init: object) => unknown;
    };
    const list = element.closest('[role="listbox"]')!;
    element.dispatchEvent(
      new page.PointerEvent('pointerdown', { bubbles: true, isPrimary: true, button: 0 }),
    );
    for (const key of pressed) list.dispatchEvent(new page.KeyboardEvent('keydown', { key, bubbles: true }));
  }, keys);
}

/** The plan list's subjects with their actions, newest first ("Pick: Add dark mode toggle"). */
const arrangement = (page: Page) =>
  historyEditor(page)
    .getByRole('option')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')!.split(' · ')[0]));

/** Drags a row with the mouse to a point of another row (0 = its top edge, 1 = its bottom). */
async function dragRow(page: Page, from: Locator, to: Locator, at: number, alt = false): Promise<void> {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + 160, a.y + a.height / 2);
  await page.mouse.down();
  const y = b.y + b.height * at;
  for (let step = 1; step <= 8; step++)
    await page.mouse.move(a.x + 164, a.y + a.height / 2 + ((y - a.y - a.height / 2) * step) / 8);
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.up();
  if (alt) await page.keyboard.up('Alt');
}

test('dragging moves commits between rows, and folds them into a commit dropped onto', async ({ page }) => {
  await openEditor(page);
  // Below "Update dependencies": "Add dark mode toggle" moves there.
  await dragRow(page, planRow(page, 'Add dark mode toggle'), planRow(page, 'Update dependencies'), 0.92);
  await expect
    .poll(() => arrangement(page))
    .toEqual([
      'Pick: Improve README',
      'Pick: Update dependencies',
      'Pick: Add dark mode toggle',
      'Pick: Polish dashboard layout',
    ]);
  // Onto "Update dependencies" with Alt: a fixup, keeping its message.
  await dragRow(
    page,
    planRow(page, 'Polish dashboard layout'),
    planRow(page, 'Update dependencies'),
    0.5,
    true,
  );
  await expect
    .poll(() => arrangement(page))
    .toEqual([
      'Pick: Improve README',
      'Fixup: Polish dashboard layout',
      'Pick: Update dependencies',
      'Pick: Add dark mode toggle',
    ]);
  await expect(historyEditor(page)).toContainText('4 commits');
  await expect(historyEditor(page).getByRole('tab', { name: /Result/ })).toContainText('3');
  // Onto "Improve README" without Alt: a squash, and the combined message opens.
  await dragRow(page, planRow(page, 'Add dark mode toggle'), planRow(page, 'Improve README'), 0.5);
  await expect(historyEditor(page).getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    'Improve README\n\nAdd dark mode toggle',
  );
  // Each drop is one step of the editor's undo.
  await planRow(page, 'Improve README').click();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  await expect
    .poll(() => arrangement(page))
    .toEqual([
      'Pick: Add dark mode toggle',
      'Pick: Improve README',
      'Pick: Update dependencies',
      'Pick: Polish dashboard layout',
    ]);
});

test('older commits join the edit without losing what was arranged', async ({ page }) => {
  await page.goto(harnessUrl({ repo: copyDemo({ stash: true }) }));
  await graphRow(page, 'Update dependencies').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: /Edit main from here/ }).click();
  await expect(historyEditor(page)).toContainText('3 commits');
  await planRow(page, 'Add dark mode toggle').click();
  await page.keyboard.press('d');

  // Named by the commit it adds (the one the edit starts after).
  await historyEditor(page)
    .getByRole('button', { name: /^Include [0-9a-f]{8}$/ })
    .click();
  await expect(historyEditor(page)).toContainText('4 commits');
  await expect
    .poll(() => arrangement(page))
    .toEqual([
      'Drop: Add dark mode toggle',
      'Pick: Improve README',
      'Pick: Update dependencies',
      'Pick: Polish dashboard layout',
    ]);
  // Past a merge commit nothing older can join.
  await expect(historyEditor(page)).toContainText('a merge: editing cannot reach past it');
  await expect(historyEditor(page).getByRole('button', { name: /^Include/ })).toHaveCount(0);
  // The list has the focus again, and its undo history still works.
  await page.keyboard.press('Control+z');
  await expect.poll(() => arrangement(page)).toContain('Pick: Add dark mode toggle');
  await expect(historyEditor(page).getByRole('option')).toHaveCount(4);
});

test('a key pressed right after a click acts on the commit just clicked', async ({ page }) => {
  await openEditor(page);
  await clickThenKeys(planRow(page, 'Improve README'), 'd');
  await expect(planRow(page, 'Improve README')).toContainText('Drop');
  await expect(planRow(page, 'Polish dashboard layout')).toContainText('Pick');

  // Moving with the arrows right after a click starts from the commit clicked.
  await planRow(page, 'Polish dashboard layout').click();
  await expect(planRow(page, 'Polish dashboard layout')).toHaveAttribute('aria-selected', 'true');
  await clickThenKeys(planRow(page, 'Update dependencies'), 'ArrowUp', 's');
  await expect(planRow(page, 'Improve README')).toContainText('Squash');
  await expect(planRow(page, 'Update dependencies')).toContainText('Pick');
  await expect(planRow(page, 'Polish dashboard layout')).toContainText('Pick');

  // Enter opens the message of the commit clicked.
  await clickThenKeys(planRow(page, 'Add dark mode toggle'), 'Enter');
  await expect(historyEditor(page).getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    'Add dark mode toggle',
  );
});

test('rows hold nothing focusable; their action menu opens from the keyboard and with a right click', async ({
  page,
}) => {
  await openEditor(page);
  // An option of a listbox must not contain other controls (axe: nested-interactive).
  const nested = await historyEditor(page)
    .getByRole('listbox')
    .evaluate(
      (list) =>
        list.querySelectorAll(
          '[role="option"] :is(button, a[href], input, select, textarea, [tabindex], [contenteditable])',
        ).length,
    );
  expect(nested).toBe(0);
  await expect(planRow(page, 'Update dependencies')).toHaveAccessibleName(
    /^Pick: Update dependencies · Bob Builder, /,
  );

  await planRow(page, 'Update dependencies').click();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitemcheckbox', { name: /^Split/ })).toBeVisible();
  await page.getByRole('menuitemcheckbox', { name: /^Split/ }).click();
  await expect(planRow(page, 'Update dependencies')).toContainText('Split');
  await expect(planRow(page, 'Update dependencies')).toHaveAccessibleName(/^Split: Update dependencies/);

  await planRow(page, 'Improve README').click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: /^Edit/ }).click();
  await expect(planRow(page, 'Improve README')).toContainText('Edit');
});

/** Opens the history editor on the commits after the one with `subject` (“Edit main from here”). */
async function editFrom(page: Page, subject: string): Promise<void> {
  await graphRow(page, subject).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit history' }).hover();
  await page.getByRole('menuitem', { name: /Edit main from here/ }).click();
  await expect(planRow(page, subject)).toHaveAttribute('aria-selected', 'true');
}

test('an arrangement that cannot be applied says why, marks its commit and offers a way out', async ({
  page,
}) => {
  await page.goto(harnessUrl({ repo: copyDemo({ stash: true }) }));
  await editFrom(page, 'Update dependencies');
  // Nothing arranged yet: Ctrl+Enter says so rather than doing nothing.
  await page.keyboard.press('Control+Enter');
  await expect(page.getByRole('status')).toContainText('Nothing to apply yet');

  // The oldest commit of the edit squashed: there is nothing below it to squash into.
  await page.keyboard.press('s');
  const state = historyEditor(page).getByRole('button', { name: 'Can’t apply' });
  await expect(state).toBeVisible();
  await expect(historyEditor(page).getByText('Applies cleanly')).toHaveCount(0);
  await expect(historyEditor(page).getByRole('button', { name: /^Apply/ })).toBeDisabled();
  await expect(planRow(page, 'Update dependencies')).toHaveAccessibleName(
    /· can’t apply: The oldest remaining commit cannot be squashed/,
  );
  // Ctrl+Enter is not dropped silently: the reason, where it is shown, lights up again (and is
  // read out), rather than a message that would cover the ways out below.
  await page.keyboard.press('Control+Enter');
  await expect(state).toHaveAttribute('data-nudge');
  await expect(historyEditor(page).locator('[aria-live]')).toHaveText(
    /^Can’t apply: The oldest remaining commit cannot be squashed/,
  );
  // The header's state selects the commit it is about.
  await planRow(page, 'Add dark mode toggle').click();
  await state.click();
  await expect(planRow(page, 'Update dependencies')).toHaveAttribute('aria-selected', 'true');

  // The ways out, after the reason: keep it as a commit of its own, or let the commit below it
  // join the edit (as the base row offers too) so that it folds into that one.
  await expect(historyEditor(page).getByRole('button', { name: 'Pick it instead' })).toBeVisible();
  const include = historyEditor(page).getByRole('button', { name: /^Include [0-9a-f]{8}$/ });
  await expect(include).toHaveCount(2);
  await include.last().click();
  await expect(historyEditor(page)).toContainText('4 commits');
  await expect(planRow(page, 'Update dependencies')).toHaveAccessibleName(
    /^Squash: Update dependencies · folds into “Polish dashboard layout”/,
  );
  await expect(state).toHaveCount(0);
  await expect(historyEditor(page).getByText('Applies cleanly')).toBeVisible();
});

test('a narrow editor shows every warning whole, keeps Undo and Redo, and its drag label inside', async ({
  page,
}) => {
  await page.setViewportSize({ width: 520, height: 720 });
  // With the uncommitted changes: they are set aside, a note says.
  await page.goto(harnessUrl({ repo: copyDemo() }));
  await editFrom(page, 'Update dependencies');
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('s');

  // The warning wraps instead of being cut; the notes fold behind one line that opens them.
  const warning = historyEditor(page).getByText(/Publishing the result needs a force push/);
  await expect(warning).toBeVisible();
  expect(await warning.evaluate((text) => text.scrollWidth <= text.clientWidth)).toBe(true);
  const note = historyEditor(page).getByText(/author dates are kept/);
  await expect(note).toBeHidden();
  await historyEditor(page).getByRole('button', { name: '2 more notes' }).click();
  await expect(note).toBeVisible();
  await expect(historyEditor(page).getByRole('button', { name: 'Fewer notes' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(historyEditor(page).getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await expect(historyEditor(page).getByRole('button', { name: 'Redo', exact: true })).toBeVisible();

  // Dragged to the right edge, above the first row: the label stays in the window, and the line
  // that shows where the commit goes is inside the list, clear of the column headers.
  await expect(historyEditor(page).getByText(/^Drag to reorder, or drop onto a commit/)).toBeVisible();
  const from = (await planRow(page, 'Improve README').boundingBox())!;
  const first = (await planRow(page, 'Add dark mode toggle').boundingBox())!;
  await page.mouse.move(from.x + 200, from.y + from.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 6; step++)
    await page.mouse.move(
      from.x + 200 + ((505 - from.x - 100) * step) / 6,
      from.y + from.height / 2 + ((first.y + 3 - from.y - from.height / 2) * step) / 6,
    );
  const label = page.getByText('Move “Improve README” here').locator('..');
  await expect(label).toBeVisible();
  const box = (await label.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(520);
  const line = (await historyEditor(page).locator('[data-insertion]').boundingBox())!;
  expect(line.y).toBeGreaterThanOrEqual(first.y);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(historyEditor(page).locator('[data-insertion]')).toHaveCount(0);
});

test('git commands wrap between their words, never inside one', async ({ page }) => {
  await openEditor(page);
  await planRow(page, 'Improve README').click();
  await page.keyboard.press('Alt+ArrowDown');
  await historyEditor(page).getByRole('tab', { name: 'Git commands' }).click();
  const rebase = historyEditor(page)
    .getByRole('complementary', { name: 'Git commands' })
    .getByRole('listitem')
    .filter({ hasText: '--empty=keep' });
  const lines = await rebase.evaluate((item) => {
    // The test project has no DOM types: elements, typed as far as needed.
    interface Box {
      readonly children: ArrayLike<unknown>;
      readonly textContent: string | null;
      readonly parentElement: Box | null;
      getBoundingClientRect(): { readonly height: number };
      getClientRects(): ArrayLike<unknown>;
    }
    const words = (Array.from(item.querySelectorAll('span > span')) as Box[]).filter(
      (word) => word.children.length === 0 && word.textContent!.trim(),
    );
    const height = words[0]!.getBoundingClientRect().height;
    return {
      // The command spans several lines…
      command: Math.round(words[0]!.parentElement!.getBoundingClientRect().height / height),
      // …but each word keeps to one.
      split: words
        .filter(
          (word) => word.getClientRects().length > 1 || word.getBoundingClientRect().height > height * 1.5,
        )
        .map((word) => word.textContent),
    };
  });
  expect(lines.command).toBeGreaterThan(1);
  expect(lines.split).toEqual([]);
});

for (const theme of ['dark-modern', 'light-modern', 'dark-hc', 'light-hc']) {
  test(`every text of the history editor reads at 4.5:1 or more (${theme})`, async ({ page }) => {
    await openEditor(page, theme);
    const list = historyEditor(page).getByRole('listbox');
    // A dropped commit, a commit folded into another, and the selected one with the list focused…
    await planRow(page, 'Polish dashboard layout').click();
    await page.keyboard.press('d');
    await planRow(page, 'Improve README').click();
    await page.keyboard.press('f');
    await planRow(page, 'Update dependencies').click();
    await expect(planRow(page, 'Update dependencies')).toHaveAttribute('aria-selected', 'true');
    expect(await lowContrast(list)).toEqual([]);
    // …and once the list lost focus (the selection has another colour then).
    await historyEditor(page).getByRole('button', { name: 'Git commands' }).focus();
    expect(await lowContrast(list)).toEqual([]);
    // The rest of the editor too: header, toolbar, result and notices, once the result cards of
    // the dropped and folded commits have faded out.
    const result = historyEditor(page).getByRole('complementary', { name: 'Result' });
    await expect(result.getByText('Polish dashboard layout')).toHaveCount(0);
    await expect(result.getByText('Improve README')).toHaveCount(0);
    // The prediction has settled (its pill is text too).
    await expect(historyEditor(page).getByText(/Applies cleanly|Conflict at/)).toBeVisible();
    expect(await lowContrast(historyEditor(page))).toEqual([]);
  });
}
