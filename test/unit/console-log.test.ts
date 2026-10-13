import { describe, expect, it } from 'vitest';
import { ConsoleLog } from '../../src/core/console/consoleLog';
import type { GitCommandEnd, GitCommandStart } from '../../src/core/git/runner';

let nextId = 1;
function command(readOnly: boolean, args = ['status']): GitCommandStart {
  return { id: nextId++, cwd: '/r', args, readOnly, background: readOnly, startedAt: Date.now() };
}
function finish(start: GitCommandStart, exitCode = 0, failed = exitCode !== 0): GitCommandEnd {
  return { ...start, durationMs: 1.234, exitCode, stderr: '', stdoutTail: '', cancelled: false, failed };
}

describe('ConsoleLog', () => {
  it('tracks a command from running to done, in start order', () => {
    const log = new ConsoleLog();
    const seen: string[] = [];
    log.onDidChange((entry) => seen.push(`${entry.id}:${entry.state}`));
    const a = command(false, ['commit']);
    const b = command(true);
    log.onCommandStart(a);
    log.onCommandStart(b);
    log.onCommandEnd(finish(b));
    log.onCommandEnd(finish(a, 1));
    expect(seen).toEqual([`${a.id}:running`, `${b.id}:running`, `${b.id}:ok`, `${a.id}:error`]);
    expect(log.history().map((e) => e.id)).toEqual([a.id, b.id]);
    expect(log.history()[0]).toMatchObject({ state: 'error', durationMs: 1.2, exitCode: 1 });
    expect(log.history()[1]).toMatchObject({ background: true });
  });

  it('shows an exit code its caller expects as an answer, not an error', () => {
    const log = new ConsoleLog();
    // `git symbolic-ref -q HEAD` exits 1 on a detached HEAD: that is what the caller asks.
    const query = command(true, ['symbolic-ref', '-q', '--short', 'HEAD']);
    log.onCommandStart(query);
    log.onCommandEnd(finish(query, 1, false));
    expect(log.history()[0]).toMatchObject({ state: 'ok', exitCode: 1 });
  });

  it('evicts finished read-only queries before state-changing commands', () => {
    const log = new ConsoleLog(3);
    const mutation = command(false, ['rebase']);
    log.onCommandStart(mutation);
    log.onCommandEnd(finish(mutation));
    const reads = [command(true), command(true), command(true)];
    for (const read of reads) {
      log.onCommandStart(read);
      log.onCommandEnd(finish(read));
    }
    const ids = log.history().map((e) => e.id);
    expect(ids).toContain(mutation.id);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain(reads[0]!.id);
  });
});
