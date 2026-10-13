import { expect, test } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, git, graphRow } from './support';

test('bisects between two selected commits from the graph and finds the first bad one', async ({ page }) => {
  const repo = copyDemo({ stash: 'including untracked' });

  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Add dark mode toggle').click();
  await graphRow(page, 'Polish dashboard layout').click({ modifiers: ['Control'] });
  await graphRow(page, 'Polish dashboard layout').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Find the commit that broke it/ }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('git bisect start');
  await sheet.getByRole('button', { name: 'Start bisecting' }).click();

  const banner = page.getByRole('region', { name: 'Operation in progress' });
  await expect(banner).toContainText('Bisecting');
  await expect(banner).toContainText('3 suspects');
  // Every commit tested has the problem: the first one after the good commit is the culprit.
  for (let i = 0; i < 4; i++) {
    const text = (await banner.textContent()) ?? '';
    if (text.includes('Found the first bad commit')) break;
    await banner.getByRole('button', { name: 'Bad' }).click();
    await expect(banner).not.toHaveText(text);
  }
  await expect(banner).toContainText('Found the first bad commit');
  await expect(banner).toContainText('Update dependencies');

  await banner.getByRole('button', { name: 'Stop bisecting' }).click();
  await expect(banner).toBeHidden();
  expect(git(repo, 'branch', '--show-current')).toBe('main');
});
