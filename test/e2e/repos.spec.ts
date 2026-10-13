import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { copyDemo, debugUrl, git, graphRow, openedDiffs } from './support';

test.use({ viewport: { width: 1440, height: 560 } });

/** git in a repository of Erin's; her commits are made on `date` when there is one. */
function gitAsErin(repo: string, date: string | undefined, ...args: string[]): string {
  const when = date ? `${date}T12:00:00Z` : undefined;
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Erin Example',
      GIT_AUTHOR_EMAIL: 'erin@nimbus.dev',
      GIT_COMMITTER_NAME: 'Erin Example',
      GIT_COMMITTER_EMAIL: 'erin@nimbus.dev',
      ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}),
    },
  }).trim();
}

/** A copy of the demo repository, and a second repository whose commits fall between its own. */
function twoRepositories(): { aurora: string; nimbus: string } {
  const aurora = copyDemo();
  const nimbus = join(dirname(aurora), 'nimbus');
  execFileSync('git', ['init', '-q', '-b', 'main', nimbus]);
  const commit = (date: string, subject: string, file: string) => {
    writeFileSync(join(nimbus, file), `${subject}\n`);
    gitAsErin(nimbus, date, 'add', '--', file);
    gitAsErin(nimbus, date, 'commit', '-q', '-m', subject);
  };
  commit('2024-01-20', 'Start the nimbus service', 'README.md');
  commit('2024-03-30', 'Read settings from the environment', 'config.go');
  gitAsErin(nimbus, undefined, 'checkout', '-q', '-b', 'feature/metrics');
  commit('2024-04-21', 'Export request metrics', 'metrics.go');
  gitAsErin(nimbus, undefined, 'checkout', '-q', 'main');
  commit('2024-06-05', 'Log slow requests', 'log.go');
  return { aurora, nimbus };
}

/** The harness with several repositories in one session (the first one is the active one). */
function params(repos: readonly string[], session: string): string {
  const search = new URLSearchParams({ theme: 'dark-modern', session });
  for (const repo of repos) search.append('repo', repo);
  return search.toString();
}

test('all repositories in one graph: markers, details from each, filter, Show in', async ({ page }) => {
  const { aurora, nimbus } = twoRepositories();
  const query = params([aurora, nimbus], randomUUID());
  await page.goto(`/?${query}`);
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();

  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /All repositories/ }).click();
  await expect(page.getByRole('tab', { name: /All repositories/ })).toHaveAttribute('aria-selected', 'true');

  // Both histories, newest first, each row marked with its repository (no uncommitted rows).
  const order = ['Add dark mode toggle', 'Log slow requests', 'Improve README', 'Update dependencies'];
  for (const [index, subject] of order.entries())
    await expect(graphRow(page, subject)).toHaveAttribute('aria-rowindex', String(index + 2));
  await expect(
    graphRow(page, 'Log slow requests').getByRole('gridcell', { name: 'nimbus', exact: true }),
  ).toHaveCount(1);
  await expect(
    graphRow(page, 'Add dark mode toggle').getByRole('gridcell', { name: 'aurora', exact: true }),
  ).toHaveCount(1);
  await expect(graphRow(page, 'Uncommitted changes')).toHaveCount(0);
  const legend = page.getByRole('group', { name: 'Repositories in this view' });
  await expect(legend.getByRole('button', { name: 'aurora', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(legend.getByRole('button', { name: 'nimbus', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Each commit's details and diffs come from its own repository.
  const details = page.getByRole('complementary', { name: 'Commit details' });
  await graphRow(page, 'Export request metrics').click();
  await expect(details.getByRole('heading', { name: 'Export request metrics' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Show in nimbus' })).toBeVisible();
  await details.getByRole('button', { name: /metrics\.go/ }).click();
  await expect
    .poll(async () =>
      (await openedDiffs(page)).some(
        (diff) => diff.repo?.endsWith('/nimbus') && diff.right?.endsWith(':metrics.go'),
      ),
    )
    .toBe(true);
  await graphRow(page, 'Update dependencies').click();
  await expect(details.getByRole('button', { name: 'Show in aurora' })).toBeVisible();
  await expect(details.getByRole('button', { name: /package\.json/ })).toBeVisible();

  // Commits of two repositories cannot be compared: the pane says so.
  await graphRow(page, 'Export request metrics').click({ modifiers: ['ControlOrMeta'] });
  await expect(details).toContainText('aurora and nimbus are separate repositories');
  await expect(details).toContainText('cannot be compared');

  // The legend filters repositories out and back in.
  await legend.getByRole('button', { name: 'nimbus', exact: true }).click();
  await expect(legend.getByRole('button', { name: 'nimbus', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(graphRow(page, 'Log slow requests')).toHaveCount(0);
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  await legend.getByRole('button', { name: 'nimbus', exact: true }).click();
  await expect(graphRow(page, 'Log slow requests')).toBeVisible();

  // Only reading here: changes are made in the repository's own log, which "Show in" opens.
  await graphRow(page, 'Export request metrics').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /Check out, branch, merge, rebase/ })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Show in nimbus' }).click();
  const repoChip = page.getByRole('banner').getByRole('button', { name: /^nimbus/ });
  await expect(repoChip).toBeVisible();
  await expect(graphRow(page, 'Export request metrics')).toHaveAttribute('aria-selected', 'true');
  // "All repositories" is no repository's: every repository's tabs have it.
  await expect(page.getByRole('tab', { name: /All repositories/ })).toHaveAttribute('aria-selected', 'false');

  // Back in aurora, it is where aurora had it, still open.
  await repoChip.click();
  await page.getByRole('menuitemcheckbox', { name: /aurora/ }).click();
  await expect(page.getByRole('tab', { name: /All repositories/ })).toHaveAttribute('aria-selected', 'true');
  await expect(graphRow(page, 'Log slow requests')).toBeVisible();

  // It is kept, renamed or not, like any tab.
  await page.getByRole('tab', { name: /All repositories/ }).dblclick();
  await page.getByRole('textbox', { name: 'Tab name' }).fill('Everything');
  await page.keyboard.press('Enter');
  await page.reload();
  await expect(page.getByRole('tab', { name: /Everything/ })).toHaveAttribute('aria-selected', 'true');
  await expect(graphRow(page, 'Log slow requests')).toBeVisible();
  await page
    .getByRole('banner')
    .getByRole('button', { name: /^aurora/ })
    .click();
  await page.getByRole('menuitemcheckbox', { name: /nimbus/ }).click();
  await expect(repoChip).toBeVisible();
  await expect(page.getByRole('tab', { name: /Everything/ })).toBeVisible();
});

/** nimbus (as above) and an app with a submodule, libs/lib. */
function appAndNimbus(): { app: string; nimbus: string } {
  const { nimbus } = twoRepositories();
  const dir = resolve(nimbus, '..');
  const lib = join(dir, 'lib');
  const app = join(dir, 'app');
  mkdirSync(lib);
  mkdirSync(app);
  git(lib, 'init', '-q', '-b', 'main');
  for (const step of [1, 2]) {
    writeFileSync(join(lib, 'lib.txt'), `step ${step}\n`);
    git(lib, 'add', 'lib.txt');
    git(lib, 'commit', '-q', '-m', `Lib step ${step}`);
  }
  git(app, 'init', '-q', '-b', 'main');
  writeFileSync(join(app, 'README.md'), '# App\n');
  git(app, 'add', 'README.md');
  git(app, 'commit', '-q', '-m', 'Start the app');
  git(app, 'submodule', 'add', '-q', '--', lib, 'libs/lib');
  git(app, 'commit', '-q', '-m', 'Add lib');
  return { app, nimbus };
}

test('the view follows repositories that open and close, and their colors stay', async ({
  page,
  request,
}) => {
  const { app, nimbus } = appAndNimbus();
  const query = params([app, nimbus], randomUUID());
  await page.goto(`/?${query}`);
  await expect(graphRow(page, 'Add lib')).toBeVisible();
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /All repositories/ }).click();
  await expect(graphRow(page, 'Log slow requests')).toBeVisible();
  const legend = page.getByRole('group', { name: 'Repositories in this view' });
  // A legend swatch's color (its style names it).
  const color = (name: string) =>
    legend.getByRole('button', { name, exact: true }).locator('span').first().getAttribute('style');
  const colors = { app: await color('app'), nimbus: await color('nimbus') };
  expect(colors.app).toMatch(/--lf-repo: rgb/);
  expect(colors.app).not.toBe(colors.nimbus);

  // Opening the submodule (from app's own log) adds a repository, and makes it the active one.
  await page.locator('[role="tab"][title="All"]').click();
  await page
    .getByRole('complementary', { name: 'Branches' })
    .getByRole('tree', { name: 'Submodules' })
    .getByRole('treeitem', { name: /^libs\/lib/ })
    .dblclick();
  await expect(page.locator('header').getByTitle(join(app, 'libs/lib'), { exact: true })).toBeVisible();
  await expect(graphRow(page, 'Lib step 2')).toBeVisible();

  // Its tabs have "All repositories" too, which now shows it as well; the others keep their colors.
  await page.getByRole('tab', { name: /All repositories/ }).click();
  await expect(legend.getByRole('button', { name: 'lib', exact: true })).toBeVisible();
  await expect(graphRow(page, 'Lib step 2').getByRole('gridcell', { name: 'lib', exact: true })).toHaveCount(
    1,
  );
  await expect(legend.getByRole('button', { name: 'lib', exact: true })).toBeVisible();
  expect({ app: await color('app'), nimbus: await color('nimbus') }).toEqual(colors);

  // A repository that closes leaves the view.
  expect((await request.get(debugUrl(page, 'close-repository', { folder: nimbus }))).status()).toBe(204);
  await expect(legend.getByRole('button', { name: 'nimbus', exact: true })).toHaveCount(0);
  await expect(graphRow(page, 'Log slow requests')).toHaveCount(0);
  await expect(graphRow(page, 'Add lib')).toBeVisible();
  expect(await color('app')).toBe(colors.app);
});

test('in a narrow panel the legend is a menu', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const { aurora, nimbus } = twoRepositories();
  await page.goto(`/?${params([aurora, nimbus], randomUUID())}`);
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /All repositories/ }).click();
  await expect(graphRow(page, 'Log slow requests')).toBeVisible();

  const repositories = page.getByRole('button', { name: 'Repositories in this view' });
  await repositories.click();
  await page.getByRole('menuitemcheckbox', { name: 'nimbus' }).click();
  await expect(graphRow(page, 'Log slow requests')).toHaveCount(0);
  await repositories.click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'nimbus' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // The last one shown stays.
  await expect(page.getByRole('menuitemcheckbox', { name: 'aurora' })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Show every repository' }).click();
  await expect(graphRow(page, 'Log slow requests')).toBeVisible();
});

test('each repository’s main line takes its color, kept when filtering', async ({ page }) => {
  const { aurora, nimbus } = twoRepositories();
  await page.goto(`/?${params([aurora, nimbus], randomUUID())}`);
  await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
  await page.getByRole('button', { name: 'New view' }).click();
  await page.getByRole('menuitem', { name: /All repositories/ }).click();
  await expect(graphRow(page, 'Log slow requests')).toBeVisible();

  const legend = page.getByRole('group', { name: 'Repositories in this view' });
  // A legend swatch's color, and a pill's (its commit's lane color), from their styles.
  const property = (style: string | null, name: string) =>
    (style ?? '')
      .split(';')
      .map((declaration) => declaration.split(':'))
      .find(([key]) => key?.trim() === name)?.[1]
      ?.trim();
  const repoColor = async (name: string) =>
    property(
      await legend.getByRole('button', { name, exact: true }).locator('span').first().getAttribute('style'),
      '--lf-repo',
    );
  const laneColor = async (subject: string, pill: string) =>
    property(
      await graphRow(page, subject).getByText(pill, { exact: true }).locator('..').getAttribute('style'),
      '--c',
    );
  const colors = { aurora: await repoColor('aurora'), nimbus: await repoColor('nimbus') };
  expect(colors.aurora).toMatch(/^rgb/);
  expect(await laneColor('Add dark mode toggle', 'main')).toBe(colors.aurora);
  // Down its first parents.
  expect(await laneColor('Improve README', 'origin/main')).toBe(colors.aurora);
  expect(await laneColor('Log slow requests', 'main')).toBe(colors.nimbus);
  // Other lines take other colors.
  for (const [subject, pill] of [
    ['Show recent searches', 'feature/search'],
    ['Export request metrics', 'feature/metrics'],
  ] as const)
    expect([colors.aurora, colors.nimbus]).not.toContain(await laneColor(subject, pill));

  // Filtering repaints nothing.
  await page.getByRole('radio', { name: 'Filter' }).click();
  await page.getByRole('textbox', { name: /Search commits/ }).fill('README');
  await expect(graphRow(page, 'Add dark mode toggle')).toHaveCount(0);
  await expect.poll(() => laneColor('Improve README', 'origin/main')).toBe(colors.aurora);
});
