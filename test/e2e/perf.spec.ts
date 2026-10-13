import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { harnessUrl } from './paths';

/**
 * Performance budgets on a large synthetic history (`npm run test:perf`; building the repository
 * takes a while). Thresholds are looser than the design budgets to absorb CI noise; the measured
 * numbers are attached to the report.
 */
const COMMITS = Number(process.env.LANEFOLD_PERF_COMMITS ?? 100_000);
const REPO = resolve(`out/perf/synthetic-${COMMITS}`);

test.describe('performance', () => {
  test.setTimeout(240_000);

  test.beforeAll(() => {
    if (!existsSync(REPO)) {
      execFileSync('node', ['dev/perf/synthetic-repo.mjs', REPO, String(COMMITS)], { stdio: 'inherit' });
    }
  });

  test(`loads and scrolls ${COMMITS.toLocaleString()} commits within budget`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 600 });
    await page.goto(harnessUrl({ repo: REPO }));
    await expect(page.getByText(`${COMMITS.toLocaleString()} commits`)).toBeVisible({ timeout: 60_000 });

    const marks = await page.evaluate(() =>
      Object.fromEntries(
        performance
          .getEntriesByType('mark')
          .map((entry) => [
            entry.name.replace(/^lanefold:/, '').replace(/:\d+$/, ''),
            Math.round(entry.startTime),
          ]),
      ),
    );
    const firstRows = marks['first-rows'] ?? Infinity;
    const firstText = marks['first-meta'] ?? Infinity;

    // A fast fling: big wheel steps every frame.
    const box = (await page.locator('[role="grid"]').first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.evaluate(() => (globalThis as { __lanefoldPerf?: { reset(): void } }).__lanefoldPerf!.reset());
    for (let i = 0; i < 180; i++) {
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(8);
    }
    await page.waitForTimeout(300);
    const frames = await page.evaluate(() =>
      (globalThis as { __lanefoldPerf?: { frameTimes(): number[] } }).__lanefoldPerf!.frameTimes(),
    );
    const sorted = [...frames].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const heapMb = await page.evaluate(
      () => ((performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576,
    );

    const summary = `first rows ${firstRows} ms, text ${firstText} ms, fling p95 ${p95.toFixed(2)} ms over ${frames.length} frames, heap ${heapMb.toFixed(1)} MB`;
    testInfo.annotations.push({ type: 'performance', description: summary });
    console.log(`[perf] ${summary}`);

    expect(firstRows).toBeLessThan(1500);
    expect(firstText).toBeLessThan(2000);
    expect(p95).toBeLessThan(6);
    if (heapMb > 0) expect(heapMb).toBeLessThan(120);
  });
});

/** Lengths (ms) of the tasks that blocked the main thread for over 50 ms while `run` ran. */
async function longTasks(page: Page, run: () => Promise<void>): Promise<number[]> {
  await page.evaluate(() => {
    // The browser's PerformanceObserver (this file is typed for Node).
    type Observer = { observe(options: { type: string }): void; disconnect(): void };
    const scope = globalThis as unknown as {
      __longTasks?: number[];
      __longTaskObserver?: Observer;
      PerformanceObserver: new (
        callback: (list: { getEntries(): { duration: number }[] }) => void,
      ) => Observer;
    };
    scope.__longTaskObserver?.disconnect();
    scope.__longTasks = [];
    scope.__longTaskObserver = new scope.PerformanceObserver((list) => {
      for (const entry of list.getEntries()) scope.__longTasks!.push(Math.round(entry.duration));
    });
    scope.__longTaskObserver.observe({ type: 'longtask' });
  });
  await run();
  // Tasks are reported after they end.
  await page.waitForTimeout(500);
  return page.evaluate(() => (globalThis as { __longTasks?: number[] }).__longTasks ?? []);
}

const elementCount = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as { document: { getElementsByTagName(tag: string): { length: number } } }
      ).document.getElementsByTagName('*').length,
  );

/** What a long history does not stress: very many refs, huge commits and working trees. */
test.describe('performance with many refs and files', () => {
  test.setTimeout(240_000);
  const REFS = resolve('out/perf/stress-refs');
  const WIDE = resolve('out/perf/stress-wide');

  test.beforeAll(() => {
    if (!existsSync(REFS))
      execFileSync('node', ['dev/perf/stress-repos.mjs', 'refs', REFS], { stdio: 'inherit' });
    if (!existsSync(WIDE))
      execFileSync('node', ['dev/perf/stress-repos.mjs', 'wide', WIDE], { stdio: 'inherit' });
  });

  test('23,000 refs load quickly and the branches pane stays responsive', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 600 });
    const tasks = await longTasks(page, async () => {
      await page.goto(harnessUrl({ repo: REFS }));
      await expect(page.getByText('5,000 commits')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('complementary', { name: 'Branches' })).toContainText('topic');
    });
    const firstRows = await page.evaluate(
      () =>
        performance.getEntriesByType('mark').find((entry) => entry.name.startsWith('lanefold:first-rows'))
          ?.startTime ?? Infinity,
    );
    const filter = await longTasks(page, async () => {
      await page.getByRole('complementary', { name: 'Branches' }).getByRole('textbox').fill('build-1999');
      await expect(page.getByRole('complementary', { name: 'Branches' })).toContainText('build-19990');
    });
    const summary = `first rows ${Math.round(firstRows)} ms, longest task loading ${Math.max(0, ...tasks)} ms, filtering ${Math.max(0, ...filter)} ms`;
    testInfo.annotations.push({ type: 'performance', description: summary });
    console.log(`[perf] refs: ${summary}`);
    expect(firstRows).toBeLessThan(2500);
    expect(Math.max(0, ...filter)).toBeLessThan(250);
  });

  test('20,000 changed files and 11,500 uncommitted changes show without freezing', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1400, height: 600 });
    await page.goto(harnessUrl({ repo: WIDE }));
    const details = page.getByRole('complementary', { name: 'Commit details' });
    const rows = page.locator('[role="grid"] [role="rowgroup"] > [role="row"]:not([hidden])');
    const commit = await longTasks(page, async () => {
      await page.getByRole('textbox', { name: /Search commits/ }).fill('Rewrite 20000 files');
      await expect(details).toContainText('Rewrite 20000 files', { timeout: 30_000 });
      await expect(details.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });
    });
    const commitElements = await elementCount(page);
    // Afresh, scrolled to the top (the uncommitted changes are the first row).
    await page.goto(harnessUrl({ repo: WIDE }));
    await expect(rows.filter({ hasText: 'Uncommitted changes' }).first()).toBeVisible({ timeout: 60_000 });
    const changes = await longTasks(page, async () => {
      await rows.filter({ hasText: 'Uncommitted changes' }).first().click();
      await expect(details.getByRole('heading', { name: 'Uncommitted changes' })).toBeVisible();
      await expect(details.getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });
    });
    const changesElements = await elementCount(page);
    const summary = `20,000-file commit: longest task ${Math.max(0, ...commit)} ms, ${commitElements} elements; 11,500 changes: longest task ${Math.max(0, ...changes)} ms, ${changesElements} elements`;
    testInfo.annotations.push({ type: 'performance', description: summary });
    console.log(`[perf] files: ${summary}`);
    expect(Math.max(0, ...commit)).toBeLessThan(400);
    expect(Math.max(0, ...changes)).toBeLessThan(400);
    expect(commitElements).toBeLessThan(20_000);
    expect(changesElements).toBeLessThan(20_000);
  });
});
