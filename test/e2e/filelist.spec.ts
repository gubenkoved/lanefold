import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fixtureDir, harnessUrl } from './paths';
import { git, graphRow } from './support';

const FILES = 600;
const FOLDERS = 30;
const path = (i: number) => `pkg-${i % FOLDERS}/file-${String(i).padStart(3, '0')}.txt`;

/** A repository whose last commit changes 600 files in 30 folders. */
function wideRepo(): string {
  const repo = fixtureDir('filelist');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '--initial-branch=main');
  const write = (suffix: string) => {
    for (let i = 0; i < FILES; i++) {
      mkdirSync(join(repo, `pkg-${i % FOLDERS}`), { recursive: true });
      writeFileSync(join(repo, path(i)), `file ${i}${suffix}\n`);
    }
  };
  write('');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Add 600 files');
  write(' changed');
  git(repo, 'commit', '-q', '-a', '-m', 'Change 600 files');
  return repo;
}

/** The path of the file whose row has focus. */
const focusedPath = (page: Page) => page.locator(':focus').getAttribute('title');

test('a long file list renders the rows near the view; the keyboard reaches every row', async ({ page }) => {
  const repo = wideRepo();
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Change 600 files').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  const items = details.getByRole('list').getByRole('listitem');
  await expect(items.first()).toHaveAttribute('aria-setsize', String(FILES));
  await expect(items.first()).toHaveAttribute('aria-posinset', '1');
  // Only the rows around the view are in the page.
  expect(await items.count()).toBeLessThan(150);

  // Scrolled half-way (600 rows of 24 px), the rows there are rendered.
  await items.first().hover();
  await page.mouse.wheel(0, (FILES * 24) / 2);
  await expect
    .poll(async () => Number(await items.first().getAttribute('aria-posinset')))
    .toBeGreaterThan(200);
  expect(await items.count()).toBeLessThan(150);

  // End and ↑ move between rows, rendering the ones they reach.
  await items.first().getByRole('button').focus();
  await page.keyboard.press('End');
  await expect.poll(() => focusedPath(page)).toBe('pkg-9/file-579.txt');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusedPath(page)).toBe('pkg-9/file-549.txt');
  await page.keyboard.press('Home');
  await expect.poll(() => focusedPath(page)).toBe('pkg-0/file-000.txt');
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await focusedPath(page))?.startsWith('pkg-0/')).toBe(true);
});

test('in tree mode folders are rows too: ← steps out and closes, → opens', async ({ page }) => {
  const repo = wideRepo();
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Change 600 files').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  await details.getByRole('button', { name: 'View as tree' }).click();
  const list = details.getByRole('list');
  const folder = list
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'pkg-0', exact: true }) });
  await expect(folder).toHaveAttribute('aria-level', '1');
  await expect(list.getByRole('listitem').filter({ hasText: 'file-000.txt' })).toHaveAttribute(
    'aria-level',
    '2',
  );
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', String(FILES + FOLDERS));

  await list.getByRole('button', { name: /file-030\.txt/ }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(folder.getByRole('button')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(folder.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await expect(list.getByRole('button', { name: /file-030\.txt/ })).toHaveCount(0);
  await expect(list.getByRole('listitem').first()).toHaveAttribute(
    'aria-setsize',
    String(FILES + FOLDERS - 20),
  );
  await page.keyboard.press('ArrowRight');
  await expect(folder.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focusedPath(page)).toBe('pkg-0/file-000.txt');
  await details.getByRole('button', { name: 'View as list' }).click();
});
