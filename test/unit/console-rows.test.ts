import { describe, expect, it } from 'vitest';
import type { ConsoleEntry } from '../../src/shared/models';
import { consoleRows } from '../../src/webview/views/consoleRows';

let nextId = 1;

/** A finished command that started `at` ms. */
function run(
  args: string[],
  at: number,
  options: { readOnly?: boolean; state?: ConsoleEntry['state']; cwd?: string } = {},
): ConsoleEntry {
  return {
    id: nextId++,
    cwd: options.cwd ?? '/repo',
    args,
    readOnly: options.readOnly ?? true,
    startedAt: at,
    state: options.state ?? 'ok',
    durationMs: 5,
  };
}

/** Each row as its command and how many times it ran. */
const shape = (entries: readonly ConsoleEntry[]) =>
  consoleRows(entries).map((row) => `${row.runs[0]!.args.join(' ')} ×${row.runs.length}`);

describe('console rows', () => {
  it('folds a query repeated within a burst of reads into its first run’s row', () => {
    const head = ['symbolic-ref', '-q', '--short', 'HEAD'];
    const remotes = ['remote'];
    const entries = [
      run(head, 0),
      run(remotes, 10),
      run(['stash', 'list'], 20),
      run(head, 30),
      run(remotes, 40),
      run(head, 900),
      run(remotes, 1500),
    ];
    expect(shape(entries)).toEqual(['symbolic-ref -q --short HEAD ×3', 'remote ×3', 'stash list ×1']);
    const rows = consoleRows(entries);
    // The row is where the first run is, and keeps every run, in order.
    expect(rows[0]!.key).toBe(entries[0]!.id);
    expect(rows[0]!.runs).toEqual([entries[0], entries[3], entries[5]]);
  });

  it('starts over after a pause, and after a command that changes the repository', () => {
    const head = ['rev-parse', 'HEAD'];
    expect(
      shape([
        run(head, 0),
        run(head, 2500),
        run(['fetch', 'origin'], 2600, { readOnly: false }),
        run(head, 2700),
        run(['commit', '-m', 'x'], 2800, { readOnly: false }),
        run(['commit', '-m', 'x'], 2810, { readOnly: false }),
        run(head, 2900),
        run(head, 2950),
      ]),
    ).toEqual([
      'rev-parse HEAD ×1',
      'rev-parse HEAD ×1',
      'fetch origin ×1',
      'rev-parse HEAD ×1',
      'commit -m x ×1',
      'commit -m x ×1',
      'rev-parse HEAD ×2',
    ]);
  });

  it('keeps failed and cancelled runs, other repositories and other arguments apart', () => {
    const status = ['status', '--porcelain=v2'];
    expect(
      shape([
        run(status, 0),
        run(status, 10, { state: 'error' }),
        run(status, 20, { state: 'cancelled' }),
        run(status, 30, { state: 'running' }),
        run(status, 40, { cwd: '/other' }),
        run([...status, '-z'], 50),
      ]),
    ).toEqual([
      'status --porcelain=v2 ×2',
      'status --porcelain=v2 ×1',
      'status --porcelain=v2 ×1',
      'status --porcelain=v2 ×1',
      'status --porcelain=v2 -z ×1',
    ]);
  });
});
