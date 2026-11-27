import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import type { OperationPlan, OperationResult } from '../../src/shared/operations';
import { initialArrangement, pickAll, type RewriteEntry } from '../../src/shared/rewrite';
import { openOps, REBASE_SCRIPT, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

/**
 * `feature` was started from `main` when it had "shared" and "old"; main was rewritten since:
 * "shared" is there again as another commit, "old" is gone, "new" was added. So feature carries
 * two commits that are not its own.
 */
describe('rebasing onto a branch with the commits arranged (real git)', () => {
  let test: TestRepo;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];
  let c: Record<'base' | 'shared' | 'old' | 'one' | 'two' | 'main', string>;

  beforeEach(async () => {
    test = await TestRepo.create();
    const base = await test.commit('base');
    const shared = await test.commit('shared', { files: { 'shared.txt': 'shared\n' } });
    const old = await test.commit('old', { files: { 'old.txt': 'old\n' } });
    await test.checkoutNew('feature');
    const one = await test.commit('one', { files: { 'one.txt': 'one\n' } });
    const two = await test.commit('two', { files: { 'two.txt': 'two\n' } });
    // The upstream is rewritten.
    await test.checkout('main');
    await test.git('reset', '-q', '--hard', base);
    await test.commit('shared, reworded', { files: { 'shared.txt': 'shared\n' } });
    const main = await test.commit('new', { files: { 'new.txt': 'new\n' } });
    await test.checkout('feature');
    c = { base, shared, old, one, two, main };
    ({ ops, run, dispose } = await openOps(test, { rebaseScript: REBASE_SCRIPT }));
  });

  afterEach(() => dispose());

  const plan = (entries: RewriteEntry[], onto = 'main'): Promise<OperationPlan> =>
    ops.plan({ kind: 'rewrite', base: null, onto, entries });
  const rebase = (entries: RewriteEntry[], onto = 'main'): Promise<OperationResult> =>
    run({ kind: 'rewrite', base: null, onto, entries });

  it('lists the commits the target lacks, and marks those it has as another commit', async () => {
    const range = (await ops.rewriteRange(null, 'main'))!;
    expect(range.base).toBe(c.base);
    expect(range.onto).toEqual({ rev: 'main', sha: c.main });
    expect(range.commits.map((commit) => commit.subject)).toEqual(['shared', 'old', 'one', 'two']);
    expect(range.alreadyThere).toEqual([c.shared]);
    expect(initialArrangement(range).map((entry) => entry.action)).toEqual(['drop', 'pick', 'pick', 'pick']);
  });

  it('drops the commits that are not the branch’s own and squashes the rest onto the target', async () => {
    const result = await rebase([
      { sha: c.shared, action: 'drop' },
      { sha: c.old, action: 'drop' },
      { sha: c.one, action: 'pick' },
      { sha: c.two, action: 'squash' },
    ]);
    expect(result, result.message).toMatchObject({ status: 'done', title: 'Rebase feature onto main' });
    expect(await test.log('HEAD')).toEqual(['one', 'new', 'shared, reworded', 'base']);
    expect(await test.git('log', '-1', '--format=%B', 'HEAD')).toBe('one\n\ntwo');
    expect(await test.git('ls-tree', '--name-only', 'HEAD')).not.toContain('old.txt');
    expect(await test.git('branch', '--show-current')).toBe('feature');
    const squashed = await test.rev('HEAD');
    expect(result.rewritten).toEqual({ [c.one]: squashed, [c.two]: squashed });
    // One undo puts the branch back where it was.
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(c.two);
  });

  it('replays the commits as they are when nothing is arranged: every commit moves anyway', async () => {
    const range = (await ops.rewriteRange(null, 'main'))!;
    const planned = await plan(pickAll(range.commits));
    expect(planned.blocked).toBeFalsy();
    expect(planned.action).toBe('Rebase');
    const args = planned.commands.at(-1)!.args;
    expect(args).toEqual(
      expect.arrayContaining(['rebase', '-i', '--reapply-cherry-picks', '--onto', 'main']),
    );
    expect(args.at(-1)).toBe(c.base);
    const result = await ops.execute(planned.id);
    expect(result, result.message).toMatchObject({ status: 'done' });
    // "shared" is replayed although the target has it (kept, as an empty commit).
    expect(await test.log('HEAD')).toEqual([
      'two',
      'one',
      'old',
      'shared',
      'new',
      'shared, reworded',
      'base',
    ]);
    expect(Object.keys(result.rewritten ?? {})).toHaveLength(4);
  });

  it('reorders while rebasing', async () => {
    const result = await rebase([
      { sha: c.shared, action: 'drop' },
      { sha: c.two, action: 'pick' },
      { sha: c.old, action: 'drop' },
      { sha: c.one, action: 'reword', message: 'One, reworded' },
    ]);
    expect(result, result.message).toMatchObject({ status: 'done' });
    expect(await test.log('HEAD')).toEqual(['One, reworded', 'two', 'new', 'shared, reworded', 'base']);
  });

  it('moves the branch to the target when every commit is dropped', async () => {
    const range = (await ops.rewriteRange(null, 'main'))!;
    const result = await rebase(range.commits.map((commit) => ({ sha: commit.sha, action: 'drop' })));
    expect(result, result.message).toMatchObject({ status: 'done' });
    expect(await test.rev('HEAD')).toBe(c.main);
    expect(await test.git('branch', '--show-current')).toBe('feature');
  });

  it('predicts conflicts against the target, step by step', async () => {
    await test.checkout('main');
    const main = await test.commit('main edits one', { files: { 'one.txt': 'theirs\n' } });
    await test.checkout('feature');
    const entries: RewriteEntry[] = [
      { sha: c.shared, action: 'drop' },
      { sha: c.old, action: 'pick' },
      { sha: c.one, action: 'pick' },
      { sha: c.two, action: 'pick' },
    ];
    const simulation = await ops.simulate(null, entries, undefined, 'main');
    expect(simulation.steps).toEqual([
      { sha: c.old, status: 'clean' },
      { sha: c.one, status: 'conflict', files: ['one.txt'] },
      { sha: c.two, status: 'unknown' },
    ]);
    // Without the commit that conflicts, the rest goes through.
    const without = entries.map((entry) =>
      entry.sha === c.one ? { ...entry, action: 'drop' as const } : entry,
    );
    expect((await ops.simulate(null, without, undefined, 'main')).steps.map((step) => step.status)).toEqual([
      'clean',
      'clean',
    ]);
    const result = await rebase(without);
    expect(result, result.message).toMatchObject({ status: 'done' });
    expect(await test.log('HEAD')).toEqual([
      'two',
      'old',
      'main edits one',
      'new',
      'shared, reworded',
      'base',
    ]);
    expect(await test.rev('HEAD~2')).toBe(main);
  });

  it('refuses to run when the target moved after planning', async () => {
    const range = (await ops.rewriteRange(null, 'main'))!;
    const planned = await plan(initialArrangement(range));
    await test.git('branch', '-f', 'main', c.base);
    expect(await ops.execute(planned.id)).toMatchObject({ status: 'refused', errorKind: 'stale' });
    expect(await test.rev('HEAD')).toBe(c.two);
  });

  it('is an ordinary edit when the branch already contains the target', async () => {
    const range = (await ops.rewriteRange(null, c.old))!;
    expect(range.onto).toBeUndefined();
    expect(range.base).toBe(c.old);
    expect(range.commits.map((commit) => commit.subject)).toEqual(['one', 'two']);
    const planned = await plan(pickAll(range.commits), c.old);
    expect(planned.blocked).toBe(true);
    expect(planned.notices[0]!.text).toMatch(/already contains/);
  });

  it('has nothing to arrange when the branch has no commits of its own', async () => {
    await test.checkoutNew('behind', c.base);
    const range = (await ops.rewriteRange(null, 'main'))!;
    expect(range.onto).toEqual({ rev: 'main', sha: c.main });
    expect(range.commits).toEqual([]);
  });

  it('says so when the target is not a commit', async () => {
    await expect(ops.rewriteRange(null, 'no-such-branch')).rejects.toThrow(/not a commit/);
    const planned = await plan([{ sha: c.one, action: 'pick' }], 'no-such-branch');
    expect(planned.blocked).toBe(true);
  });
});
