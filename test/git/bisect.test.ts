import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import type { Operation } from '../../src/shared/operations';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

describe('bisect (real git)', () => {
  let test: TestRepo;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];
  const commits: string[] = [];

  beforeEach(async () => {
    test = await TestRepo.create();
    commits.length = 0;
    // Ten commits; the bug arrives in commit 7 and stays.
    for (let i = 1; i <= 10; i++)
      commits.push(
        await test.commit(`step ${i}`, { files: { 'app.txt': i >= 7 ? `buggy ${i}\n` : `fine ${i}\n` } }),
      );
    ({ ops, run, dispose } = await openOps(test));
  });

  afterEach(() => dispose());

  it('finds the first bad commit by testing what it checks out, then returns to the branch', async () => {
    const plan = await ops.plan({ kind: 'bisectStart', bad: 'HEAD', good: [commits[0]!] });
    expect(plan.commands[0]!.args).toEqual(['bisect', 'start', commits[9], commits[0]]);
    await ops.execute(plan.id);
    let state = await ops.opState();
    expect(state.kind).toBe('bisect');
    expect(state.bisect).toMatchObject({ bad: commits[9], good: [commits[0]], remaining: 9 });
    expect(state.bisect!.suspects).toHaveLength(9);

    // Test what bisect checked out, as a person would.
    for (let guard = 0; guard < 10 && !state.bisect?.firstBad; guard++) {
      const buggy = (await test.git('show', 'HEAD:app.txt')).startsWith('buggy');
      const result = await run({ kind: 'bisectMark', verdict: buggy ? 'bad' : 'good' });
      expect(result.status).toBe('done');
      state = await ops.opState();
    }
    expect(state.bisect!.firstBad).toBe(commits[6]);
    expect(state.bisect!.firstBadSubject).toBe('step 7');
    expect(ops.undoInfo.undo).toBeUndefined();

    await run({ kind: 'abort' });
    expect((await ops.opState()).kind).toBeUndefined();
    expect(await test.git('branch', '--show-current')).toBe('main');
    expect(await test.rev('HEAD')).toBe(commits[9]);
    expect(ops.undoInfo.undo).toBeUndefined();
  });

  it('refuses what makes no sense', async () => {
    const blocked = async (operation: Operation) => {
      const plan = await ops.plan(operation);
      expect(plan.blocked).toBe(true);
      return plan.notices.find((n) => n.level === 'danger')!.text;
    };
    expect(await blocked({ kind: 'bisectStart', bad: commits[0]!, good: ['HEAD'] })).toMatch(/must be older/);
    expect(await blocked({ kind: 'bisectMark', verdict: 'good' })).toMatch(/No bisect/);
    await test.write('app.txt', 'local edit\n');
    expect(await blocked({ kind: 'bisectStart', bad: 'HEAD', good: [commits[0]!] })).toMatch(
      /Commit or stash/,
    );
  });
});
