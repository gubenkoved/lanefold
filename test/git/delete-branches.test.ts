import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import type { Operation, OperationPlan } from '../../src/shared/operations';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

describe('deleting several branches at once (real git)', () => {
  let remote: TestRepo;
  let local: TestRepo;
  let outside: string;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];
  /** The tips of the branches, as made below. */
  let tip: Record<'merged' | 'squashed' | 'stacked' | 'live', string>;

  beforeEach(async () => {
    remote = await TestRepo.create({ bare: true });
    local = await TestRepo.create();
    await local.commits('one', 'two');
    await local.addRemote('origin', remote);
    await local.git('push', '-q', '-u', 'origin', 'main');
    // Merged into main: git deletes it with -d.
    await local.checkoutNew('merged');
    const merged = await local.commit('merged work');
    await local.git('push', '-q', '-u', 'origin', 'merged');
    await local.checkout('main');
    await local.merge('merged');
    // Merged on the server some other way (a squash): its commits are on no other branch here.
    await local.checkoutNew('squashed');
    await local.commits('squash one', 'squash two');
    await local.git('push', '-q', '-u', 'origin', 'squashed');
    // A branch on top of it: they share its commits.
    await local.checkoutNew('stacked');
    await local.commit('stacked work');
    await local.git('push', '-q', '-u', 'origin', 'stacked');
    // A branch still on the remote, with a commit main lacks.
    await local.checkoutNew('live', 'main');
    await local.commit('live work');
    await local.git('push', '-q', '-u', 'origin', 'live');
    await local.checkout('main');
    tip = {
      merged,
      squashed: await local.rev('squashed'),
      stacked: await local.rev('stacked'),
      live: await local.rev('live'),
    };
    // Deleted on the remote (merged pull requests), and pruned here: their upstreams are gone.
    await remote.git('branch', '-D', 'merged', 'squashed', 'stacked');
    await local.git('fetch', '-q', '--prune');
    outside = await mkdtemp(join(tmpdir(), 'lanefold-wt-'));
    ({ ops, run, dispose } = await openOps(local));
  });

  afterEach(async () => {
    await dispose();
    await remote.dispose();
    await rm(outside, { recursive: true, force: true });
  });

  const said = (plan: OperationPlan, level?: string) =>
    plan.notices
      .filter((notice) => !level || notice.level === level)
      .map((notice) => notice.text)
      .join('\n');
  const deleteBranches = (...names: string[]): Operation => ({ kind: 'deleteBranches', names });
  const branches = () => local.git('branch', '--list', '--format=%(refname:short)');
  /** A branch's upstream, as its settings name it (`[remote, merge]`). */
  const settingsOf = (branch: string) =>
    local.git('config', '--get-regexp', `^branch\\.${branch}\\.(remote|merge)$`);

  it('uses -d for the merged ones and -D for the others, and counts the commits left behind once', async () => {
    expect(await local.git('for-each-ref', '--format=%(upstream:track)', 'refs/heads/squashed')).toBe(
      '[gone]',
    );
    const plan = await ops.plan(deleteBranches('merged', 'squashed', 'stacked'));
    expect(plan).toMatchObject({
      title: 'Delete 3 branches',
      action: 'Delete branches',
      destructive: true,
      risk: 'Leaves commits behind',
      // squashed's two and stacked's one: the two shared are counted once.
      orphaned: 3,
      summary: 'Delete merged; its commits are all in the current branch. Delete squashed and stacked.',
    });
    expect(plan.commands.map((command) => command.args)).toEqual([
      ['branch', '-d', '--end-of-options', 'merged'],
      ['branch', '-D', '--end-of-options', 'squashed', 'stacked'],
    ]);
    expect(plan.commands[1]!.flags).toEqual([
      { flag: '-D', meaning: 'delete even though some of their commits are on no other branch' },
    ]);
    expect(said(plan, 'danger')).toBe(
      '3 commits of squashed and stacked are on no other branch and will no longer be on any branch. Undo brings the branches back.',
    );
    expect(said(plan, 'info')).toBe('');
    expect(plan.changes).toEqual([
      { ref: 'refs/heads/merged', from: tip.merged },
      { ref: 'refs/heads/squashed', from: tip.squashed },
      { ref: 'refs/heads/stacked', from: tip.stacked },
    ]);

    expect(await ops.execute(plan.id)).toMatchObject({
      status: 'done',
      outcome: 'Deleted 3 branches',
      message: `merged was at ${tip.merged.slice(0, 8)}, squashed was at ${tip.squashed.slice(0, 8)}, stacked was at ${tip.stacked.slice(0, 8)}`,
    });
    expect(await branches()).toBe('live\nmain');
    // git deleted their settings with them.
    expect(await settingsOf('squashed').catch(() => '')).toBe('');
    expect(ops.undoInfo.undo).toBe('Delete 3 branches');
  });

  it('Undo brings every branch back with its upstream; Redo deletes them again', async () => {
    await run(deleteBranches('merged', 'squashed', 'stacked'));
    expect((await ops.undo()).status).toBe('done');
    expect(await branches()).toBe('live\nmain\nmerged\nsquashed\nstacked');
    for (const name of ['merged', 'squashed', 'stacked'] as const) {
      expect(await local.rev(name)).toBe(tip[name]);
      expect(await settingsOf(name)).toBe(
        `branch.${name}.remote origin\nbranch.${name}.merge refs/heads/${name}`,
      );
    }
    expect(await local.git('for-each-ref', '--format=%(upstream:track)', 'refs/heads/stacked')).toBe(
      '[gone]',
    );

    expect((await ops.redo()).status).toBe('done');
    expect(await branches()).toBe('live\nmain');
    // Their settings went with them again, as git does: a new branch of that name tracks nothing.
    await local.branch('stacked', 'main');
    expect(await settingsOf('stacked').catch(() => '')).toBe('');
  });

  it('keeps the branch checked out and those checked out in other worktrees, saying so', async () => {
    const folder = join(outside, 'stacked');
    await local.git('worktree', 'add', '-q', folder, 'stacked');
    await local.checkout('squashed');
    const plan = await ops.plan(deleteBranches('merged', 'squashed', 'stacked', 'nope'));
    expect(plan).toMatchObject({
      title: 'Delete branch merged',
      action: 'Delete branch',
      destructive: false,
    });
    expect(plan.blocked).toBeFalsy();
    expect(said(plan, 'info')).toBe(
      [
        'There is no branch named nope.',
        'squashed is checked out, so it stays: switch to another branch to delete it.',
        `stacked is checked out in another worktree, ${folder}, so it stays.`,
      ].join('\n'),
    );
    // merged is in the branch checked out (squashed starts after it).
    expect(plan.commands.map((command) => command.args)).toEqual([
      ['branch', '-d', '--end-of-options', 'merged'],
    ]);
    expect(await ops.execute(plan.id)).toMatchObject({ status: 'done', outcome: 'Deleted branch merged' });
    expect(await branches()).toBe('live\nmain\nsquashed\nstacked');

    // Nothing left to delete: it says why, whatever else.
    const none = await ops.plan(deleteBranches('squashed', 'stacked'));
    expect(none).toMatchObject({ blocked: true, impossible: true, title: 'Delete branches' });
    expect(said(none, 'danger')).toBe(
      [
        'squashed is checked out, so it stays: switch to another branch to delete it.',
        `stacked is checked out in another worktree, ${folder}, so it stays.`,
      ].join('\n'),
    );
    expect(await ops.execute(none.id)).toMatchObject({ status: 'refused' });
    await rm(folder, { recursive: true, force: true });
    expect(said(await ops.plan(deleteBranches('stacked')), 'danger')).toBe(
      `stacked is checked out in a worktree whose folder is gone (${folder}), so it stays: prune worktrees first.`,
    );
    expect((await ops.plan(deleteBranches())).notices).toEqual([
      { level: 'danger', text: 'There are no branches to delete.' },
    ]);
  });

  it('checks each branch against its upstream when it has one, as git does', async () => {
    const plan = await ops.plan(deleteBranches('live', 'merged'));
    expect(plan.commands.map((command) => [command.args, command.explanation])).toEqual([
      [
        ['branch', '-d', '--end-of-options', 'live', 'merged'],
        'Delete live and merged; their commits are all in their upstreams or the current branch.',
      ],
    ]);
    expect(plan.destructive).toBe(false);
    expect(said(plan, 'info')).toBe('The remote branch origin/live is not deleted.');
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await branches()).toBe('main\nsquashed\nstacked');
    expect(await local.git('branch', '-r', '--list', 'origin/live')).toContain('origin/live');

    // A commit not pushed yet: git would refuse -d.
    expect((await ops.undo()).status).toBe('done');
    await local.checkout('live');
    await local.commit('not pushed');
    await local.checkout('main');
    const ahead = await ops.plan(deleteBranches('live'));
    expect(ahead.commands.map((command) => command.args)).toEqual([
      ['branch', '-D', '--end-of-options', 'live'],
    ]);
    expect(said(ahead, 'danger')).toBe(
      '1 commit of live is on no other branch and will no longer be on any branch. Undo brings the branch back.',
    );
  });

  it('names the branches in the confirmation past a few', async () => {
    await remote.git('branch', '-D', 'live');
    await local.git('fetch', '-q', '--prune');
    expect(await run(deleteBranches('live', 'merged', 'squashed', 'stacked'))).toMatchObject({
      status: 'done',
      outcome: 'Deleted 4 branches',
      message: 'live, merged, squashed and 1 more.',
    });
    expect(await branches()).toBe('main');
    expect((await ops.undo()).status).toBe('done');
    expect(await branches()).toBe('live\nmain\nmerged\nsquashed\nstacked');
  });
});
