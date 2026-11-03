import { expect, test, type Page } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, debugUrl, git, graphRow } from './support';

/*
 * Links to the code host, with the demo's origin on GitHub: the card of a commit's hash, the
 * menus of commits, branches and changed files, and the issue references in commit messages.
 */

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/** A copy of the demo whose origin is on GitHub, with a pushed commit that names an issue. */
function hostedDemo(): string {
  const repo = copyDemo();
  git(repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/aurora.git');
  const linked = git(
    repo,
    'commit-tree',
    '-p',
    'origin/main',
    '-m',
    'Link the forecast docs (#12)',
    '-m',
    'The units changed: see https://example.com/docs/units.',
    'origin/main^{tree}',
  );
  git(repo, 'update-ref', 'refs/remotes/origin/docs', linked);
  return repo;
}

const details = (page: Page) => page.getByRole('complementary', { name: 'Commit details' });
/** The hash of the commit in the details (named by its short hash; its title says it copies). */
const hashChip = (page: Page, sha: string) =>
  details(page).getByRole('button', { name: sha.slice(0, 8), exact: true });

/** The web pages the page asked the host to open. */
async function opened(page: Page): Promise<string[]> {
  const response = await page.request.get(debugUrl(page, 'opened-links'));
  if (!response.ok()) throw new Error(`${response.url()}: ${response.status()}`);
  return (await response.json()) as string[];
}

/** What the page put on the clipboard (the test project has no DOM types: typed as far as used). */
const clipboard = (page: Page) =>
  page.evaluate(() =>
    (
      globalThis as unknown as { navigator: { clipboard: { readText(): Promise<string> } } }
    ).navigator.clipboard.readText(),
  );

test('the hash offers a pushed commit on GitHub: open it, copy its link', async ({ page }) => {
  const repo = hostedDemo();
  const sha = git(repo, 'rev-parse', 'origin/main');
  const url = `https://github.com/acme/aurora/commit/${sha}`;
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Improve README').click();

  await hashChip(page, sha).hover();
  const card = page.getByRole('group', { name: `Commit ${sha}` });
  await expect(card).toContainText('acme/aurora');
  await card.getByRole('button', { name: /^Open on GitHub/ }).click();
  await expect.poll(() => opened(page)).toEqual([url]);
  await expect(card).toBeHidden();

  await hashChip(page, sha).hover();
  await card.getByRole('button', { name: 'Copy link' }).click();
  await expect.poll(() => clipboard(page)).toBe(url);
  // A click on the hash itself still copies the hash.
  await hashChip(page, sha).click();
  await expect.poll(() => clipboard(page)).toBe(sha);
});

test('the hash card says when no remote has the commit', async ({ page }) => {
  const repo = hostedDemo();
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Add dark mode toggle').click();
  await hashChip(page, git(repo, 'rev-parse', 'main')).hover();
  const card = page.getByRole('group', { name: /^Commit / });
  await expect(card).toContainText('Not on GitHub yet: no branch of origin has it.');
  await expect(card.getByRole('button', { name: /^Open on/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Copy hash' })).toBeVisible();
});

test('the hash card works from the keyboard', async ({ page }) => {
  const repo = hostedDemo();
  const chip = hashChip(page, git(repo, 'rev-parse', 'origin/main'));
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Improve README').click();
  // From the control before the hash (the author's statistics), Tab reaches it.
  await details(page)
    .getByRole('button', { name: /^Statistics for/ })
    .focus();
  await page.keyboard.press('Tab');
  await expect(chip).toBeFocused();
  const card = page.getByRole('group', { name: /^Commit / });
  await expect(card.getByRole('button', { name: /^Open on GitHub/ })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(card.getByRole('button', { name: /^Open on GitHub/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(chip).toBeFocused();
});

test('menus open commits, comparisons, branches and files on GitHub', async ({ page }) => {
  const repo = hostedDemo();
  const base = 'https://github.com/acme/aurora';
  const readme = git(repo, 'rev-parse', 'origin/main');
  const dependencies = git(repo, 'rev-parse', 'origin/main~1');
  await page.goto(harnessUrl({ repo }));

  await graphRow(page, 'Improve README').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open on GitHub' }).click();
  await expect.poll(() => opened(page)).toEqual([`${base}/commit/${readme}`]);

  await graphRow(page, 'Improve README').click();
  await graphRow(page, 'Update dependencies').click({ modifiers: ['Control'] });
  await graphRow(page, 'Update dependencies').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open the comparison on GitHub' }).click();
  await expect
    .poll(async () => (await opened(page)).at(-1))
    .toBe(`${base}/compare/${dependencies}...${readme}`);

  // A local branch: its upstream's page.
  const pane = page.getByRole('complementary', { name: 'Branches' });
  await pane.getByRole('textbox', { name: 'Filter branches and tags' }).fill('feature/search');
  await pane
    .getByRole('tree')
    .getByRole('treeitem', { name: 'feature/search' })
    .first()
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy link' }).click();
  await expect.poll(() => clipboard(page)).toBe(`${base}/tree/feature/search`);
  // One without an upstream has no page: the item says why.
  await pane.getByRole('textbox', { name: 'Filter branches and tags' }).fill('feature/login');
  await pane
    .getByRole('tree')
    .getByRole('treeitem', { name: 'feature/login' })
    .first()
    .click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Open on GitHub' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');

  // A file as the commit left it.
  await graphRow(page, 'Improve README').click();
  await details(page)
    .getByRole('listitem')
    .filter({ hasText: 'README.md' })
    .first()
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open on GitHub' }).click();
  await expect.poll(async () => (await opened(page)).at(-1)).toBe(`${base}/blob/${readme}/README.md`);
});

test('commit messages link issues and web addresses', async ({ page }) => {
  const repo = hostedDemo();
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Link the forecast docs').click();
  const issue = details(page).getByRole('link', { name: '#12' });
  await expect(issue).toHaveAttribute('href', 'https://github.com/acme/aurora/issues/12');
  await expect(details(page).getByRole('link', { name: 'https://example.com/docs/units' })).toBeVisible();
  await issue.click();
  await expect.poll(() => opened(page)).toEqual(['https://github.com/acme/aurora/issues/12']);
});

test('a repository on no code host shows the hash as ever', async ({ page }) => {
  // The demo's origin is a folder.
  const repo = copyDemo();
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Improve README').click();
  await hashChip(page, git(repo, 'rev-parse', 'origin/main')).hover();
  await page.waitForTimeout(600);
  await expect(page.getByRole('group', { name: /^Commit / })).toHaveCount(0);
  await graphRow(page, 'Improve README').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /^Open on/ })).toHaveCount(0);
});
