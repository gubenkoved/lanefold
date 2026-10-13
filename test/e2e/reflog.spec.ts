import { expect, test } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, git } from './support';

test('the reflog says what happened in words, and takes focus when it opens', async ({ page }) => {
  const repo = copyDemo({ stash: true });
  git(repo, 'checkout', '-q', 'feature/login');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'reset', '-q', '--hard', 'HEAD~1');

  await page.goto(harnessUrl({ repo }));
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /Reflog/ }).click();
  const list = page.getByRole('listbox', { name: 'Reflog' });
  await expect(list).toBeFocused();
  const entries = list.getByRole('option');
  await expect(entries.nth(0)).toContainText('Reset main to 1c1a40e3 “Improve README”');
  await expect(entries.nth(1)).toContainText('Checked out main');
  await expect(entries.nth(2)).toContainText('Checked out feature/login');
  // What git noted stays at hand: in the tooltip, and with the entry's details.
  await expect(entries.nth(0)).toHaveAttribute('title', 'HEAD@{0}: reset: moving to HEAD~1');
  await page.keyboard.press('ArrowDown');
  await expect(entries.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('complementary', { name: 'Reflog entry' })).toContainText(
    'checkout: moving from feature/login to main',
  );
});

test('the reflog finds a commit a hard reset lost, and a branch brings it back', async ({ page }) => {
  const repo = copyDemo();
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Work I am about to lose');
  const lost = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'reset', '-q', '--hard', 'HEAD~1');

  await page.goto(harnessUrl({ repo }));
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /Reflog/ }).click();

  const list = page.getByRole('listbox', { name: 'Reflog' });
  const entry = list.getByRole('option', { name: /Work I am about to lose/ });
  await expect(entry).toContainText('lost');
  await entry.click();
  const details = page.getByRole('complementary', { name: 'Reflog entry' });
  await expect(details).toContainText('No branch or tag holds this commit');
  await details.getByRole('button', { name: 'New branch here…' }).click();

  const sheet = page.getByRole('dialog');
  await sheet.getByRole('textbox', { name: /Branch name/ }).fill('rescued');
  await sheet.getByRole('button', { name: 'Create branch' }).click();
  const rescued = () => {
    try {
      return git(repo, 'rev-parse', '--verify', '-q', 'rescued');
    } catch {
      return '';
    }
  };
  await expect.poll(rescued).toBe(lost);
  // Held by a branch now: no longer lost.
  await expect(entry).not.toContainText('lost');
  // Checking the branch out added a reflog entry (every HEAD@{n} shifted): the selection stayed.
  await expect(list.getByRole('option').first()).toContainText(/rescued/);
  await expect(details.getByRole('heading', { level: 2 })).toHaveText('Work I am about to lose');
  await expect(list.getByRole('option', { selected: true })).toContainText('Work I am about to lose');
});
