import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { DEMO_REPO, harnessUrl } from './paths';
import { copyDemo, graphRow } from './support';

/**
 * Accessibility audit: axe (WCAG 2.1 A and AA) over every view and the transient UI (menus,
 * the review sheet, the history editor, inline diffs), in each harness theme. Text contrast of
 * the history editor, split banner and commit box is also measured through their colour layers (see contrast.ts).
 */
const THEMES = ['dark-modern', 'light-modern', 'dark-hc', 'light-hc'];

// Reduced motion: moves and resizes are instant and CSS fades shorter, so audits wait less for them.
test.use({ reducedMotion: 'reduce' });
// A test runs several axe audits, and on a busy machine one alone can take 5 seconds.
test.describe.configure({ timeout: 90_000 });

/** A second, small repository next to a copy of the demo one. */
function secondRepository(next: string): string {
  const repo = join(next, '..', 'nimbus');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Erin Example',
    GIT_AUTHOR_EMAIL: 'erin@nimbus.dev',
    GIT_COMMITTER_NAME: 'Erin Example',
    GIT_COMMITTER_EMAIL: 'erin@nimbus.dev',
  };
  for (const [date, subject] of [
    ['2024-02-01T12:00:00Z', 'Start the nimbus service'],
    ['2024-05-01T12:00:00Z', 'Log slow requests'],
  ]) {
    writeFileSync(join(repo, `${subject.length}.txt`), `${subject}\n`);
    execFileSync('git', ['-C', repo, 'add', '-A'], { env });
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', subject], {
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  }
  return repo;
}

/**
 * Waits until nothing has animated for a few frames in a row: no CSS transition or animation, and
 * none of the fades motion plays as Web Animations (it starts them a frame after an element
 * appears). Endless animations, like spinners, do not count.
 */
async function animationsFinished(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // The test project has no DOM types: what is used of them, typed as far as needed.
    const scope = globalThis as unknown as {
      document: {
        getAnimations(): {
          playState: string;
          effect: { getComputedTiming(): { endTime?: unknown } } | null;
        }[];
      };
      requestAnimationFrame(callback: () => void): number;
    };
    const animating = () =>
      scope.document
        .getAnimations()
        .some(
          (animation) =>
            animation.playState === 'running' && animation.effect?.getComputedTiming().endTime !== Infinity,
        );
    let still = 0;
    while (still < 3) {
      await new Promise<void>((resolve) => scope.requestAnimationFrame(() => resolve()));
      still = animating() ? 0 : still + 1;
    }
  });
}

/** Runs axe on the page as it is and reports every violation (the test goes on to the next state). */
async function audit(page: Page, state: string) {
  // Half-faded text reads as low contrast: entrance animations finish first.
  await animationsFinished(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const report = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help}\n` +
      violation.nodes
        .slice(0, 6)
        .map(
          (node) => `    ${node.target.join(' ')} — ${node.failureSummary?.split('\n').slice(1).join(' ')}`,
        )
        .join('\n'),
  );
  expect.soft(report, `${state}: accessibility violations`).toEqual([]);
}

for (const theme of THEMES) {
  test.describe(`accessibility (${theme})`, () => {
    test('log, details, branches and uncommitted changes', async ({ page }) => {
      await page.goto(harnessUrl({ repo: copyDemo(), theme }));
      await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
      await audit(page, 'log, nothing selected');
      await graphRow(page, 'Add dark mode toggle').click();
      await expect(page.getByRole('complementary', { name: 'Commit details' })).toContainText(
        'Add dark mode toggle',
      );
      await audit(page, 'one commit selected');
      await graphRow(page, 'Uncommitted changes').click();
      await expect(page.getByRole('form', { name: 'Commit' })).toBeVisible();
      await audit(page, 'uncommitted changes');
      const details = page.getByRole('complementary', { name: 'Commit details' });
      await details.getByRole('button', { name: 'Show changes in dashboard.css' }).click();
      await expect(details.getByRole('listbox').first()).toBeVisible();
      await audit(page, 'an inline diff');
      await graphRow(page, 'Add dark mode toggle').click();
      await graphRow(page, 'Merge branch').click({ modifiers: ['Control'] });
      await audit(page, 'two commits compared');
    });

    test('menus, the review sheet and the history editor', async ({ page }) => {
      await page.goto(harnessUrl({ repo: copyDemo(), theme }));
      await graphRow(page, 'Add dark mode toggle').click({ button: 'right' });
      await expect(page.getByRole('menu')).toBeVisible();
      await audit(page, 'commit menu');
      await page.getByRole('menuitem', { name: /New branch/ }).click();
      // A sheet is dimmed until its plan comes (slow under load): audited once the plan names it.
      await expect(page.getByRole('dialog', { name: 'Create a branch' })).toBeVisible();
      await audit(page, 'review sheet with a form');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
      const tree = page.getByRole('complementary', { name: 'Branches' }).getByRole('tree');
      await tree.getByRole('treeitem', { name: /^origin\s*\d/ }).click({ button: 'right' });
      await expect(page.getByRole('menu')).toBeVisible();
      await audit(page, 'remote menu');
      await page.keyboard.press('Escape');
      await tree.getByRole('treeitem', { name: 'Add remote…' }).click();
      await expect(page.getByRole('dialog', { name: 'Add a remote' })).toBeVisible();
      await audit(page, 'add remote sheet');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
      await graphRow(page, 'Add dark mode toggle').click();
      await page.keyboard.press('F2');
      await expect(page.getByRole('region', { name: /Edit history of/ })).toBeVisible();
      await audit(page, 'history editor');
    });

    test('stashes, reflog, console and compare views', async ({ page }) => {
      await page.goto(harnessUrl({ repo: copyDemo(), theme }));
      await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
      for (const [preset, ready] of [
        [/Stashes/, /stash/i],
        [/Reflog/, /HEAD/],
      ] as const) {
        await page.getByRole('button', { name: 'New view' }).click();
        await page.getByRole('menuitem', { name: preset }).click();
        await expect(page.getByRole('tabpanel')).toContainText(ready);
        await audit(page, `${String(preset)} view`);
      }
      await page.getByRole('tab', { name: /Console/ }).click();
      await page.getByRole('button', { name: /All commands/ }).click();
      await audit(page, 'console');
      await page.getByRole('button', { name: 'New view' }).click();
      await page.getByRole('menuitem', { name: /Compare/ }).click();
      await audit(page, 'compare picker');
    });

    test('statistics, overall and for one author', async ({ page }) => {
      await page.goto(harnessUrl({ repo: DEMO_REPO, theme }));
      await page.getByRole('button', { name: 'New view' }).click();
      await page.getByRole('menuitem', { name: /Statistics/ }).click();
      const view = page.getByRole('tabpanel', { name: 'Statistics' });
      const authors = view.getByRole('listbox', { name: 'Contributors' });
      await expect(authors.getByRole('option')).toHaveCount(4);
      await expect(view.getByRole('list', { name: 'Languages' })).toBeVisible();
      await audit(page, 'statistics');
      await view
        .getByRole('radiogroup', { name: 'Activity shows' })
        .getByRole('radio', { name: 'Lines' })
        .click();
      await view
        .getByRole('group', { name: /^Lines added and removed per/ })
        .getByRole('button')
        .first()
        .hover();
      await audit(page, 'statistics, lines per period with a tooltip');
      await authors.getByRole('option', { name: /^Carol Chen/ }).click();
      await expect(view.getByRole('region', { name: 'About Carol Chen' })).toBeVisible();
      await audit(page, 'statistics of one author');
    });

    test('all repositories in one graph', async ({ page }) => {
      const aurora = copyDemo();
      const nimbus = secondRepository(aurora);
      const search = new URLSearchParams({ theme, session: randomUUID() });
      search.append('repo', aurora);
      search.append('repo', nimbus);
      await page.goto(`/?${search.toString()}`);
      await expect(graphRow(page, 'Add dark mode toggle')).toBeVisible();
      await page.getByRole('button', { name: 'New view' }).click();
      await page.getByRole('menuitem', { name: /All repositories/ }).click();
      await expect(graphRow(page, 'Log slow requests')).toBeVisible();
      await audit(page, 'all repositories');
      await graphRow(page, 'Log slow requests').click();
      await expect(page.getByRole('complementary', { name: 'Commit details' })).toContainText(
        'Log slow requests',
      );
      await audit(page, 'all repositories, a commit selected');
    });
  });
}
