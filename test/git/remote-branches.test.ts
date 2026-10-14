import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import type { Operation, OperationPlan } from '../../src/shared/operations';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

describe('branches on remotes, and upstreams (real git)', () => {
  let remote: TestRepo;
  let local: TestRepo;
  let otherDir: string;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];
  /** The commit of feature, on its own branch (here and on origin). */
  let feature: string;

  /** Another developer's clone, for changing origin from "elsewhere". */
  const other = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', join(otherDir, 'clone'), '-c', 'user.name=Bob', '-c', 'user.email=bob@x', ...args],
      { encoding: 'utf8', env: { ...process.env, ...local.env } },
    ).trim();

  beforeEach(async () => {
    remote = await TestRepo.create({ bare: true });
    local = await TestRepo.create();
    await local.commits('one', 'two');
    await local.addRemote('origin', remote);
    await local.git('push', '-q', '-u', 'origin', 'main');
    await local.checkoutNew('feature');
    feature = await local.commit('feature work');
    await local.git('push', '-q', '-u', 'origin', 'feature');
    await local.checkout('main');
    otherDir = await mkdtemp(join(tmpdir(), 'lanefold-other-'));
    execFileSync('git', ['clone', '-q', remote.path, join(otherDir, 'clone')], {
      env: { ...process.env, ...local.env },
    });
    ({ ops, run, dispose } = await openOps(local));
  });

  afterEach(async () => {
    await dispose();
    await remote.dispose();
    await rm(otherDir, { recursive: true, force: true });
  });

  const said = (plan: OperationPlan, level?: string) =>
    plan.notices
      .filter((notice) => !level || notice.level === level)
      .map((notice) => notice.text)
      .join('\n');

  async function blocked(operation: Operation, reason: RegExp): Promise<void> {
    const plan = await ops.plan(operation);
    expect(plan.blocked).toBe(true);
    expect(said(plan, 'danger')).toMatch(reason);
    expect(await ops.execute(plan.id)).toMatchObject({ status: 'refused' });
  }

  /** The upstream of a local branch, in full ('' for none, or no such branch). */
  const upstreamOf = (branch: string) =>
    local.git('for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`);
  const onRemote = (branch: string) => remote.git('branch', '--list', '--format=%(refname:short)', branch);
  const remoteBranchHere = (name: string) =>
    local.git('branch', '-r', '--list', '--format=%(refname:short)', name);

  describe('deleting a branch from its remote', () => {
    it('pushes the delete, leased to where it was last fetched; it is not undoable', async () => {
      const plan = await ops.plan({ kind: 'deleteRemoteBranch', name: 'origin/feature' });
      expect(plan).toMatchObject({
        title: 'Delete branch feature from origin',
        action: 'Delete from remote',
        destructive: true,
        risk: 'Deletes it from the remote',
      });
      expect(plan.commands.map((command) => command.args)).toEqual([
        [
          'push',
          `--force-with-lease=refs/heads/feature:${feature}`,
          'origin',
          '--delete',
          'refs/heads/feature',
        ],
      ]);
      expect(plan.changes).toEqual([{ ref: 'refs/remotes/origin/feature', from: feature }]);
      expect(said(plan, 'danger')).toBe(
        'Everyone who fetches from origin loses feature; Undo cannot bring it back there.',
      );
      // The local branch has its commit; it tracks it.
      expect(said(plan, 'info')).toMatch(/^feature tracks it: afterwards, its upstream shows as gone/);

      expect(await ops.execute(plan.id)).toMatchObject({
        status: 'done',
        outcome: 'Deleted feature from origin',
        message: `Deleted feature from origin. It was at ${feature.slice(0, 8)}.`,
      });
      expect(await onRemote('feature')).toBe('');
      expect(await remoteBranchHere('origin/feature')).toBe('');
      expect(await local.git('for-each-ref', '--format=%(upstream:track)', 'refs/heads/feature')).toBe(
        '[gone]',
      );
      expect(ops.undoInfo.undo).toBeUndefined();
    });

    it('counts the commits only it has, and warns of the remote’s default branch', async () => {
      other('switch', '-q', '-c', 'idea');
      other('commit', '-q', '--allow-empty', '-m', 'their idea');
      other('push', '-q', 'origin', 'idea');
      await run({ kind: 'fetch' });
      const idea = await ops.plan({ kind: 'deleteRemoteBranch', name: 'origin/idea' });
      expect(idea).toMatchObject({ orphaned: 1, risk: 'Deletes it from the remote · Leaves commits behind' });
      expect(said(idea, 'danger')).toMatch(
        /1 commit is only on it: no branch keeps it after that\. To keep it, create a branch at origin\/idea first\.$/,
      );
      expect(said(idea, 'info')).toBe('');

      await local.git('remote', 'set-head', 'origin', 'main');
      const main = await ops.plan({ kind: 'deleteRemoteBranch', name: 'origin/main' });
      expect(said(main, 'warning')).toBe(
        'main is origin’s default branch: the remote will most likely refuse to delete it.',
      );
      // It does.
      const result = await ops.execute(main.id);
      expect(result).toMatchObject({
        status: 'failed',
        message:
          'Not deleted: it is the remote’s current branch, which the remote does not let anyone delete.',
      });
      expect(await onRemote('main')).toBe('main');
      expect(await remoteBranchHere('origin/main')).toBe('origin/main');
    });

    it('keeps what someone pushed since the last fetch', async () => {
      other('switch', '-q', 'feature');
      other('commit', '-q', '--allow-empty', '-m', 'more work');
      other('push', '-q', 'origin', 'feature');
      const theirs = other('rev-parse', 'HEAD');
      const result = await run({ kind: 'deleteRemoteBranch', name: 'origin/feature' });
      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/^Not deleted: it changed on the remote since your last fetch/);
      expect(await remote.git('rev-parse', 'feature')).toBe(theirs);
      expect(await local.rev('origin/feature')).toBe(feature);
    });

    it('is done when the remote had deleted it already, and its remote branch here goes', async () => {
      other('push', '-q', 'origin', '--delete', 'feature');
      expect(await run({ kind: 'deleteRemoteBranch', name: 'origin/feature' })).toMatchObject({
        status: 'done',
        outcome: 'origin had deleted feature already',
        message: 'origin had deleted feature already. origin/feature is gone from here now too.',
      });
      expect(await remoteBranchHere('origin/feature')).toBe('');
    });

    it('finds the remote of a name with “/” in it, and refuses what it cannot delete', async () => {
      await local.git('remote', 'add', 'team/ci', remote.path);
      await local.git('fetch', '-q', 'team/ci');
      const plan = await ops.plan({ kind: 'deleteRemoteBranch', name: 'team/ci/feature' });
      expect(plan.title).toBe('Delete branch feature from team/ci');
      expect(plan.commands[0]!.args).toEqual([
        'push',
        `--force-with-lease=refs/heads/feature:${feature}`,
        'team/ci',
        '--delete',
        'refs/heads/feature',
      ]);

      await blocked({ kind: 'deleteRemoteBranch', name: 'origin/nope' }, /There is no remote branch named/);
      // Left behind by a remote that is gone.
      await local.git('update-ref', 'refs/remotes/old/main', 'main');
      await blocked(
        { kind: 'deleteRemoteBranch', name: 'old/main' },
        /old\/main belongs to no remote of this repository any more/,
      );
    });
  });

  describe('deleting a branch with its remote branch', () => {
    it('deletes both; Undo brings the branch back, tracking as it did', async () => {
      const plan = await ops.plan({ kind: 'deleteBranch', name: 'feature', remote: true });
      expect(plan).toMatchObject({
        title: 'Delete branch feature and origin/feature',
        action: 'Delete both',
        destructive: true,
        remoteBranch: 'origin/feature',
        // Its commit is on these two only.
        orphaned: 1,
      });
      expect(plan.commands.map((command) => command.args)).toEqual([
        ['branch', '-d', '--end-of-options', 'feature'],
        [
          'push',
          `--force-with-lease=refs/heads/feature:${feature}`,
          'origin',
          '--delete',
          'refs/heads/feature',
        ],
      ]);
      expect(said(plan, 'danger')).toMatch(
        /^1 commit is only on feature and origin\/feature, and will no longer be on any branch\. Undo brings feature back, but not origin\/feature\./,
      );
      expect(await ops.execute(plan.id)).toMatchObject({
        status: 'done',
        outcome: 'Deleted branch feature and origin/feature',
      });
      expect(await local.git('branch', '--list', 'feature')).toBe('');
      expect(await onRemote('feature')).toBe('');
      expect(await remoteBranchHere('origin/feature')).toBe('');

      expect((await ops.undo()).status).toBe('done');
      expect(await local.rev('feature')).toBe(feature);
      expect(await upstreamOf('feature')).toBe('refs/remotes/origin/feature');
      expect(await onRemote('feature')).toBe('');
    });

    it('offers it only while the upstream is on the remote', async () => {
      // Without asking, the plan names the remote branch it could delete too (the sheet offers it).
      const plain = await ops.plan({ kind: 'deleteBranch', name: 'feature' });
      expect(plain.remoteBranch).toBe('origin/feature');
      expect(said(plain, 'info')).toBe('The remote branch origin/feature is not deleted.');
      await local.branch('local-only', 'main');
      expect((await ops.plan({ kind: 'deleteBranch', name: 'local-only' })).remoteBranch).toBeUndefined();
      await blocked(
        { kind: 'deleteBranch', name: 'local-only', remote: true },
        /local-only has no upstream on a remote to delete/,
      );

      other('push', '-q', 'origin', '--delete', 'feature');
      await run({ kind: 'fetch', prune: true });
      await blocked(
        { kind: 'deleteBranch', name: 'feature', remote: true },
        /origin\/feature is gone from the remote already/,
      );
      expect((await ops.plan({ kind: 'deleteBranch', name: 'feature' })).remoteBranch).toBeUndefined();
    });

    it('is done when the remote had deleted it already', async () => {
      other('push', '-q', 'origin', '--delete', 'feature');
      expect(await run({ kind: 'deleteBranch', name: 'feature', remote: true })).toMatchObject({
        status: 'done',
        outcome: 'Deleted branch feature and origin/feature',
        message: `feature was at ${feature.slice(0, 8)}. origin had deleted feature already. origin/feature is gone from here now too.`,
      });
      expect(await remoteBranchHere('origin/feature')).toBe('');
    });

    it('when the remote refuses, says the branch is deleted here all the same, and Undo brings it back', async () => {
      // Someone pushed to feature since the last fetch: the lease keeps it.
      other('switch', '-q', 'feature');
      other('commit', '-q', '--allow-empty', '-m', 'their work');
      other('push', '-q', 'origin', 'feature');
      const theirs = other('rev-parse', 'HEAD');
      const result = await run({ kind: 'deleteBranch', name: 'feature', remote: true });
      expect(result.status).toBe('failed');
      expect(result.message).toMatch(
        /^feature is deleted here \(Undo brings it back\), but origin\/feature is not\. It changed on the remote since your last fetch, so the lease kept it\./,
      );
      expect(await local.git('branch', '--list', 'feature')).toBe('');
      expect(await remote.git('rev-parse', 'feature')).toBe(theirs);
      expect(result.entry?.title).toBe('Delete branch feature and origin/feature');
      expect((await ops.undo()).status).toBe('done');
      expect(await local.rev('feature')).toBe(feature);
      expect(await upstreamOf('feature')).toBe('refs/remotes/origin/feature');
    });

    it('is not offered for an upstream that is no branch on the remote, and asking for it can be taken back', async () => {
      // A pull request's head, fetched as a remote branch.
      await local.git('push', '-q', 'origin', 'feature:refs/pull/1/head');
      await local.git('config', '--add', 'remote.origin.fetch', '+refs/pull/*/head:refs/remotes/origin/pr/*');
      await run({ kind: 'fetch' });
      await local.git('branch', '--set-upstream-to=origin/pr/1', 'feature');
      const plain = await ops.plan({ kind: 'deleteBranch', name: 'feature' });
      expect(plain.remoteBranch).toBeUndefined();
      expect(said(plain, 'info')).toBe('The remote branch origin/pr/1 is not deleted.');
      // Asked for all the same: blocked, but the form stays open (unticking it deletes the branch here).
      const asked = await ops.plan({ kind: 'deleteBranch', name: 'feature', remote: true });
      expect(asked.blocked).toBe(true);
      expect(asked.impossible).toBeUndefined();
      expect(said(asked, 'danger')).toMatch(
        /origin\/pr\/1 is not a branch Lanefold can delete from its remote/,
      );
    });
  });

  it('Undo of a branch deletion brings its upstream back; Redo deletes that again', async () => {
    await run({ kind: 'deleteBranch', name: 'feature' });
    expect(await upstreamOf('feature')).toBe('');
    expect((await ops.undo()).status).toBe('done');
    expect(await upstreamOf('feature')).toBe('refs/remotes/origin/feature');
    expect((await ops.redo()).status).toBe('done');
    expect(await local.git('branch', '--list', 'feature')).toBe('');
    // Its settings went with it, as git does: a new branch of that name tracks nothing.
    await local.branch('feature', 'main');
    expect(await upstreamOf('feature')).toBe('');
  });

  describe('upstreams', () => {
    it('sets, changes and stops tracking; not undoable, it says how to go back', async () => {
      await local.branch('topic', 'main');
      const plan = await ops.plan({ kind: 'setUpstream', branch: 'topic', upstream: 'origin/feature' });
      expect(plan).toMatchObject({
        title: 'Set the upstream of topic to origin/feature',
        action: 'Set upstream',
        destructive: false,
      });
      expect(plan.commands[0]!.args).toEqual([
        'branch',
        '--set-upstream-to=refs/remotes/origin/feature',
        '--end-of-options',
        'topic',
      ]);
      expect(said(plan, 'info')).toBe(
        [
          'As of the last fetch, topic has 1 commit to pull.',
          'This changes topic’s settings, not its history: Undo cannot take it back. To go back, stop tracking it.',
        ].join('\n'),
      );
      expect(await ops.execute(plan.id)).toMatchObject({
        status: 'done',
        outcome: 'Set the upstream of topic to origin/feature',
        message: 'topic tracks origin/feature now: 1 commit to pull.',
      });
      expect(await upstreamOf('topic')).toBe('refs/remotes/origin/feature');
      expect(ops.undoInfo.undo).toBeUndefined();

      await blocked(
        { kind: 'setUpstream', branch: 'topic', upstream: 'origin/feature' },
        /topic already tracks origin\/feature/,
      );
      await blocked(
        { kind: 'setUpstream', branch: 'topic', upstream: 'main' },
        /There is no remote branch named main/,
      );

      // A local branch named like the remote one does not get in the way.
      await local.branch('origin/main', 'main');
      const change = await ops.plan({ kind: 'setUpstream', branch: 'topic', upstream: 'origin/main' });
      expect(said(change, 'info')).toMatch(/To go back, set its upstream to origin\/feature again\.$/);
      expect((await ops.execute(change.id)).status).toBe('done');
      expect(await upstreamOf('topic')).toBe('refs/remotes/origin/main');
      await local.git('branch', '-D', 'origin/main');

      const unset = await ops.plan({ kind: 'setUpstream', branch: 'topic' });
      expect(unset).toMatchObject({ title: 'Stop tracking origin/main', action: 'Stop tracking' });
      expect(unset.commands[0]!.args).toEqual(['branch', '--unset-upstream', '--end-of-options', 'topic']);
      expect(await ops.execute(unset.id)).toMatchObject({
        status: 'done',
        outcome: 'Stopped tracking origin/main',
        message: 'topic has no upstream now: pull needs one, and its next push sets one.',
      });
      expect(await upstreamOf('topic')).toBe('');
      await blocked({ kind: 'setUpstream', branch: 'topic' }, /topic has no upstream/);
    });

    it('lets pull and push work for a branch made without one', async () => {
      // feature made again, from main, by hand: no upstream, and origin/feature ahead of it.
      await run({ kind: 'deleteBranch', name: 'feature' });
      await local.git('branch', '--no-track', 'feature', 'main');
      await local.checkout('feature');
      expect((await ops.plan({ kind: 'pull', mode: 'ff-only' })).blocked).toBe(true);
      await run({ kind: 'setUpstream', branch: 'feature', upstream: 'origin/feature' });
      await run({ kind: 'pull', mode: 'ff-only' });
      expect(await local.rev('feature')).toBe(feature);
    });

    it('warns of a remote branch with no history in common', async () => {
      await local.git('checkout', '-q', '--orphan', 'lonely');
      await local.commit('a new start');
      await local.checkout('main');
      const plan = await ops.plan({ kind: 'setUpstream', branch: 'lonely', upstream: 'origin/main' });
      expect(said(plan, 'warning')).toBe(
        'lonely and origin/main have no commit in common: git refuses to pull unrelated histories.',
      );
    });
  });
});
