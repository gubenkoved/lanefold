import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import type { Repository } from '../../src/core/repo/repository';
import { readWorktrees } from '../../src/core/repo/worktrees';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

describe('worktrees (real git)', () => {
  let test: TestRepo;
  let repo: Repository;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];
  let outside: string;

  beforeEach(async () => {
    test = await TestRepo.create();
    await test.commits('one', 'two');
    await test.git('branch', 'feature');
    ({ repo, ops, run, dispose } = await openOps(test));
    outside = await mkdtemp(join(tmpdir(), 'lanefold-wt-'));
  });

  afterEach(async () => {
    await dispose();
    await rm(outside, { recursive: true, force: true });
  });

  it('checks a branch out in a new folder, lists it, and removes it again', async () => {
    const folder = join(outside, 'feature');
    const plan = await ops.plan({ kind: 'addWorktree', path: folder, branch: 'feature' });
    expect(plan.commands[0]!.args).toEqual(['worktree', 'add', '--', folder, 'feature']);
    expect((await ops.execute(plan.id)).status).toBe('done');
    const trees = await readWorktrees(repo);
    expect(trees.map((tree) => [tree.branch, tree.main, tree.current])).toEqual([
      ['main', true, true],
      ['feature', false, false],
    ]);
    expect(ops.undoInfo.undo).toBeUndefined();

    // The branch is now taken: a second worktree for it is refused before git is asked.
    expect(
      (await ops.plan({ kind: 'addWorktree', path: join(outside, 'again'), branch: 'feature' })).blocked,
    ).toBe(true);

    const remove = await ops.plan({ kind: 'removeWorktree', path: folder });
    expect(remove.destructive).toBe(true);
    await ops.execute(remove.id);
    expect(existsSync(folder)).toBe(false);
    expect((await readWorktrees(repo)).length).toBe(1);
    expect(await test.git('branch', '--list', 'feature')).toContain('feature');
  });

  it('creates a new branch for the worktree, and prunes worktrees whose folder is gone', async () => {
    const folder = join(outside, 'spike');
    await run({ kind: 'addWorktree', path: folder, newBranch: 'spike', at: 'HEAD~1' });
    expect(await test.git('rev-parse', 'spike')).toBe(await test.rev('HEAD~1'));
    await rm(folder, { recursive: true, force: true });
    expect((await readWorktrees(repo)).find((tree) => tree.branch === 'spike')?.prunable).toBeTruthy();
    await run({ kind: 'pruneWorktrees' });
    expect((await readWorktrees(repo)).length).toBe(1);
    expect((await ops.plan({ kind: 'pruneWorktrees' })).blocked).toBe(true);
  });

  it('never removes the main worktree', async () => {
    expect((await ops.plan({ kind: 'removeWorktree', path: test.path })).blocked).toBe(true);
  });
});
