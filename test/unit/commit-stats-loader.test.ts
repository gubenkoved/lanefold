import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitStats } from '../../src/shared/models';
import {
  CommitStatsLoader,
  FILES_BATCH,
  LINES_BATCH,
  LINES_BATCH_FILES,
  SETTLE_MS,
  type StatsWant,
} from '../../src/webview/graph/commitStats';

const sha = (index: number) => index.toString(16).padStart(40, '0');
const shas = (from: number, count: number) => Array.from({ length: count }, (_, i) => sha(from + i));

interface Call {
  readonly shas: readonly string[];
  readonly lines: boolean;
  readonly signal: AbortSignal;
  /** Answers with these commits' counts (every commit asked for, unless given). */
  answer(only?: readonly string[]): Promise<void>;
  fail(): Promise<void>;
}

/** A loader over a host that answers when the test says so; `files(sha)`: the files a commit changed. */
function setup(files: (sha: string) => number = () => 1) {
  const cache = new Map<string, CommitStats>();
  const calls: Call[] = [];
  let changes = 0;
  const settled = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
  const loader = new CommitStatsLoader(
    cache,
    (list, lines, signal) =>
      new Promise<readonly CommitStats[]>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Cancelled')));
        calls.push({
          shas: list,
          lines,
          signal,
          answer: (only = list) => {
            resolve(
              only.map((commit) => ({
                sha: commit,
                added: files(commit),
                modified: 0,
                removed: 0,
                ...(lines ? { lines: { added: 3, removed: 1, binary: 0 } } : {}),
              })),
            );
            return settled();
          },
          fail: () => {
            reject(new Error('git failed'));
            return settled();
          },
        });
      }),
    () => changes++,
  );
  const want = (list: readonly string[], near: number, tier: StatsWant) => {
    loader.want(list, near, tier);
    vi.advanceTimersByTime(SETTLE_MS);
  };
  return { cache, calls, loader, want, settled, changes: () => changes };
}

describe('loading what commits changed for the graph’s columns', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks nothing while neither column shows', () => {
    const { calls, want } = setup();
    want(shas(0, 30), 30, 'none');
    want([], 0, 'none');
    expect(calls).toEqual([]);
  });

  it('asks nothing while the graph scrolls: only for the rows it stops at', () => {
    const { calls, loader } = setup();
    for (let top = 0; top < 500; top += 10) {
      loader.want(shas(top, 30), 30, 'files');
      vi.advanceTimersByTime(SETTLE_MS - 1);
    }
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls.map((call) => [call.shas, call.lines])).toEqual([[shas(490, 30), false]]);
  });

  it('reads files only, when only their column shows', async () => {
    const { cache, calls, want, changes } = setup();
    want(shas(0, 30), 20, 'files');
    await calls[0]!.answer();
    expect(calls).toHaveLength(1);
    expect(changes()).toBe(1);
    expect(cache.get(sha(0))).toEqual({ sha: sha(0), added: 1, modified: 0, removed: 0 });
    // Known commits are not asked for again.
    want([...shas(0, 30), sha(99)], 20, 'files');
    expect(calls[1]!.shas).toEqual([sha(99)]);
  });

  it('reads the files first, then the lines of the commits near the screen', async () => {
    const { cache, calls, want } = setup();
    want(shas(0, 60), 25, 'lines');
    expect(calls.map((call) => call.lines)).toEqual([false]);
    expect(calls[0]!.shas).toEqual(shas(0, 60));
    await calls[0]!.answer();
    // Lines are not read for the rows further off.
    expect(calls[1]!).toMatchObject({ lines: true, shas: shas(0, 25) });
    await calls[1]!.answer();
    expect(calls).toHaveLength(2);
    expect(cache.get(sha(3))?.lines).toEqual({ added: 3, removed: 1, binary: 0 });
    expect(cache.get(sha(40))?.lines).toBeUndefined();
  });

  it('asks in batches, the nearest commits first', async () => {
    const { calls, want } = setup();
    want(shas(0, FILES_BATCH + 50), LINES_BATCH + 5, 'lines');
    expect(calls[0]!.shas).toEqual(shas(0, FILES_BATCH));
    await calls[0]!.answer();
    // The rest of the files and the first lines are read side by side.
    expect(calls[1]!).toMatchObject({ lines: false, shas: shas(FILES_BATCH, 50) });
    expect(calls[2]!).toMatchObject({ lines: true, shas: shas(0, LINES_BATCH) });
    await calls[2]!.answer();
    expect(calls[3]!).toMatchObject({ lines: true, shas: shas(LINES_BATCH, 5) });
  });

  it('reads the lines of a huge commit by itself, so that it does not hold the others back', async () => {
    const huge = sha(3);
    const { calls, want } = setup((commit) => (commit === huge ? LINES_BATCH_FILES * 20 : 10));
    want(shas(0, 8), 8, 'lines');
    await calls[0]!.answer();
    expect(calls[1]!).toMatchObject({ lines: true, shas: shas(0, 3) });
    await calls[1]!.answer();
    expect(calls[2]!).toMatchObject({ lines: true, shas: [huge] });
    await calls[2]!.answer();
    expect(calls[3]!).toMatchObject({ lines: true, shas: shas(4, 4) });
  });

  it('stops a read that serves no row any more, and keeps one that still does', async () => {
    const { calls, want, settled } = setup();
    want(shas(0, 30), 30, 'files');
    // Scrolled a little: some of what is being read still shows.
    want(shas(20, 30), 30, 'files');
    expect(calls[0]!.signal.aborted).toBe(false);
    expect(calls).toHaveLength(1);
    // Scrolled far away: it is stopped, and the rows now on screen are read.
    want(shas(500, 30), 30, 'files');
    expect(calls[0]!.signal.aborted).toBe(true);
    await settled();
    expect(calls[1]!.shas).toEqual(shas(500, 30));
  });

  it('stops reading when the columns are switched off', async () => {
    const { calls, want, settled } = setup();
    want(shas(0, 30), 30, 'lines');
    await calls[0]!.answer();
    expect(calls[1]!.lines).toBe(true);
    want([], 0, 'none');
    expect(calls[1]!.signal.aborted).toBe(true);
    await settled();
    expect(calls).toHaveLength(2);
  });

  it('reads no lines once their column goes, the files’ staying', async () => {
    const { calls, want, settled } = setup();
    want(shas(0, 10), 10, 'lines');
    await calls[0]!.answer();
    want(shas(0, 10), 10, 'files');
    await calls[1]!.answer();
    await settled();
    expect(calls).toHaveLength(2);
  });

  it('does not ask again for what git did not answer, until other rows show', async () => {
    const { calls, want } = setup();
    want(shas(0, 4), 4, 'files');
    await calls[0]!.answer(shas(0, 2));
    expect(calls).toHaveLength(1);
    // Other rows: the commits left out are tried again with them.
    want(shas(1, 4), 4, 'files');
    expect(calls[1]!.shas).toEqual(shas(2, 3));
    await calls[1]!.fail();
    expect(calls).toHaveLength(2);
  });

  it('keeps the lines it read when the files alone arrive later', async () => {
    const { cache, calls, want } = setup();
    cache.set(sha(0), {
      sha: sha(0),
      added: 1,
      modified: 0,
      removed: 0,
      lines: { added: 9, removed: 9, binary: 0 },
    });
    want(shas(0, 2), 2, 'files');
    expect(calls[0]!.shas).toEqual([sha(1)]);
    await calls[0]!.answer(shas(0, 2));
    expect(cache.get(sha(0))?.lines).toEqual({ added: 9, removed: 9, binary: 0 });
  });

  it('reads nothing once disposed', async () => {
    const { calls, loader, want, settled } = setup();
    want(shas(0, 5), 5, 'lines');
    loader.dispose();
    expect(calls[0]!.signal.aborted).toBe(true);
    await settled();
    want(shas(10, 5), 5, 'lines');
    expect(calls).toHaveLength(1);
  });
});
