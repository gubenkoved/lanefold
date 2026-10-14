import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import type { Operation, OperationPlan } from '../../src/shared/operations';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

describe('renaming a branch on its remote too (real git)', () => {
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

  /**
   * Blocked for `reason` (a notice of its own), by what the form can change (its fields stay
   * usable), and refused if run anyway. Returns that notice.
   */
  async function blocked(operation: Operation, reason: RegExp): Promise<OperationPlan['notices'][number]> {
    const plan = await ops.plan(operation);
    expect(plan.blocked).toBe(true);
    expect(plan.impossible).toBeUndefined();
    const notice = plan.notices.find((n) => n.level === 'danger' && reason.test(n.text));
    expect(notice, said(plan, 'danger')).toBeDefined();
    expect(await ops.execute(plan.id)).toMatchObject({ status: 'refused' });
    return notice!;
  }

  /** The upstream of a local branch, in full ('' for none, or no such branch). */
  const upstreamOf = (branch: string) =>
    local.git('for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`);
  const onRemote = (branch: string) => remote.git('branch', '--list', '--format=%(refname:short)', branch);
  const remoteBranchHere = (name: string) =>
    local.git('branch', '-r', '--list', '--format=%(refname:short)', name);
  const rename = (from: string, to: string): Operation => ({ kind: 'renameBranch', from, to, remote: true });

  it('pushes it under the new name, tracked, and deletes the old one, leased; Undo renames it back here only', async () => {
    const plan = await ops.plan(rename('feature', 'topic'));
    expect(plan).toMatchObject({
      title: 'Rename feature to topic, here and on origin',
      action: 'Rename both',
      destructive: true,
      risk: 'Renames it on the remote',
      remoteBranch: 'origin/feature',
      upstreamRemote: 'origin',
    });
    expect(plan.blocked).toBeFalsy();
    expect(plan.commands.map((command) => command.args)).toEqual([
      ['branch', '-m', '--end-of-options', 'feature', 'topic'],
      ['push', '--set-upstream', '--force-with-lease=refs/heads/topic:', 'origin', 'refs/heads/topic'],
      [
        'push',
        `--force-with-lease=refs/heads/feature:${feature}`,
        'origin',
        '--delete',
        'refs/heads/feature',
      ],
    ]);
    // If git cannot publish it, the branch takes back its old name: nothing is half done.
    expect(plan.commands[1]!.onFailure).toEqual(['branch', '-m', '--end-of-options', 'topic', 'feature']);
    expect(plan.changes).toEqual([
      { ref: 'refs/heads/feature', from: feature },
      { ref: 'refs/heads/topic', to: feature },
      { ref: 'refs/remotes/origin/topic', to: feature },
      { ref: 'refs/remotes/origin/feature', from: feature },
    ]);
    expect(said(plan, 'danger')).toBe(
      'Everyone who fetches from origin loses feature and gets topic instead; Undo renames the branch back here only, not on origin.',
    );
    expect(said(plan, 'warning')).toBe('');
    expect(said(plan, 'info')).toBe('');

    expect(await ops.execute(plan.id)).toMatchObject({
      status: 'done',
      outcome: 'Renamed feature to topic, here and on origin',
    });
    expect(await local.git('branch', '--list', 'feature')).toBe('');
    expect(await local.rev('topic')).toBe(feature);
    expect(await upstreamOf('topic')).toBe('refs/remotes/origin/topic');
    expect(await onRemote('feature')).toBe('');
    expect(await remote.rev('topic')).toBe(feature);
    expect(await remoteBranchHere('origin/feature')).toBe('');
    expect(await local.rev('origin/topic')).toBe(feature);

    // The name here only: the branch tracks what the remote has, under the new name.
    expect((await ops.undo()).status).toBe('done');
    expect(await local.git('branch', '--list', 'topic')).toBe('');
    expect(await local.rev('feature')).toBe(feature);
    expect(await upstreamOf('feature')).toBe('refs/remotes/origin/topic');
    expect(await onRemote('feature')).toBe('');
    expect(await onRemote('topic')).toBe('topic');
    expect((await ops.redo()).status).toBe('done');
    expect(await upstreamOf('topic')).toBe('refs/remotes/origin/topic');
  });

  it('offers it only while the upstream is on the remote; without it, the remote branch keeps its name', async () => {
    const plain = await ops.plan({ kind: 'renameBranch', from: 'feature', to: 'topic' });
    expect(plain).toMatchObject({
      title: 'Rename feature to topic',
      action: 'Rename',
      destructive: false,
      remoteBranch: 'origin/feature',
      upstreamRemote: 'origin',
    });
    expect(plain.commands).toHaveLength(1);
    expect(said(plain, 'info')).toBe(
      'The remote branch origin/feature keeps its name, and the branch still tracks it.',
    );
    // Before a new name is typed, the sheet offers it already (the commands come with the name).
    const untouched = await ops.plan(rename('feature', 'feature'));
    expect(untouched).toMatchObject({
      title: 'Rename feature, here and on origin',
      remoteBranch: 'origin/feature',
    });
    expect(untouched.commands).toHaveLength(1);

    await local.branch('local-only', 'main');
    expect(
      (await ops.plan({ kind: 'renameBranch', from: 'local-only', to: 'x' })).remoteBranch,
    ).toBeUndefined();
    await blocked(rename('local-only', 'x'), /^local-only has no upstream branch on a remote to rename\.$/);

    other('push', '-q', 'origin', '--delete', 'feature');
    await run({ kind: 'fetch', prune: true });
    expect(
      (await ops.plan({ kind: 'renameBranch', from: 'feature', to: 'topic' })).remoteBranch,
    ).toBeUndefined();
    await blocked(rename('feature', 'topic'), /^origin\/feature is gone from the remote already\.$/);
  });

  it('publishes the commits the remote branch lacks with it', async () => {
    await local.checkout('feature');
    const ahead = await local.commit('more work');
    await local.checkout('main');
    const plan = await ops.plan(rename('feature', 'topic'));
    expect(said(plan, 'info')).toBe('1 commit of feature that origin/feature lacks is published with it.');
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await remote.rev('topic')).toBe(ahead);
    expect(await onRemote('feature')).toBe('');
  });

  it('refuses to drop commits only the old name has there, or to take a name the remote has', async () => {
    // Someone pushed to feature, and a fetch brought it: the branch here lacks that commit.
    other('switch', '-q', 'feature');
    other('commit', '-q', '--allow-empty', '-m', 'their work');
    other('push', '-q', 'origin', 'feature');
    other('switch', '-q', '-c', 'taken', 'main');
    other('push', '-q', 'origin', 'taken');
    await run({ kind: 'fetch' });
    await blocked(
      rename('feature', 'topic'),
      /^origin\/feature has 1 commit that feature lacks, which renaming it on origin would drop: pull first\.$/,
    );
    // Here only, it can.
    expect((await ops.plan({ kind: 'renameBranch', from: 'feature', to: 'topic' })).blocked).toBeFalsy();

    await run({ kind: 'moveBranch', name: 'feature', to: 'origin/feature' });
    const taken = await blocked(rename('feature', 'taken'), /^origin has a branch named taken already\.$/);
    expect(taken.field).toBe('to');

    // A branch tracking a remote branch of the name it is given: nothing to rename there.
    await local.git('branch', '--track', 'work', 'origin/taken');
    await blocked(
      rename('work', 'taken'),
      /^work tracks origin\/taken, which has that name already: rename it here only\.$/,
    );
  });

  it('is done when the remote had deleted the old name already', async () => {
    other('push', '-q', 'origin', '--delete', 'feature');
    expect(await run(rename('feature', 'topic'))).toMatchObject({
      status: 'done',
      outcome: 'Renamed feature to topic, here and on origin',
      message: `feature was at ${feature.slice(0, 8)}, topic created at ${feature.slice(0, 8)}. origin had deleted feature already. origin/feature is gone from here now too.`,
    });
    expect(await remoteBranchHere('origin/feature')).toBe('');
    expect(await remote.rev('topic')).toBe(feature);
    expect(await upstreamOf('topic')).toBe('refs/remotes/origin/topic');
    expect(ops.undoInfo.undo).toBe('Rename feature to topic, here and on origin');
  });

  it('keeps the old name here when the new one cannot be published', async () => {
    // Someone took the name on origin since the last fetch: the lease keeps their branch.
    other('switch', '-q', '-c', 'topic', 'main');
    other('push', '-q', 'origin', 'topic');
    const theirs = other('rev-parse', 'HEAD');
    const result = await run(rename('feature', 'topic'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/^Push rejected: /);
    expect(result.entry).toBeUndefined();
    expect(await local.rev('feature')).toBe(feature);
    expect(await local.git('branch', '--list', 'topic')).toBe('');
    expect(await upstreamOf('feature')).toBe('refs/remotes/origin/feature');
    expect(await remote.rev('topic')).toBe(theirs);
    expect(await remote.rev('feature')).toBe(feature);
    expect(ops.undoInfo.undo).toBeUndefined();
  });

  it('when the old name cannot be deleted, the new one stays published and Undo renames it back here', async () => {
    // Someone pushed to feature since the last fetch: the lease keeps it.
    other('switch', '-q', 'feature');
    other('commit', '-q', '--allow-empty', '-m', 'their work');
    other('push', '-q', 'origin', 'feature');
    const theirs = other('rev-parse', 'HEAD');
    const result = await run(rename('feature', 'topic'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(
      /^feature is renamed to topic, here and on origin, but origin\/feature is still there\. It changed on the remote since your last fetch/,
    );
    expect(await local.rev('topic')).toBe(feature);
    expect(await upstreamOf('topic')).toBe('refs/remotes/origin/topic');
    expect(await remote.rev('topic')).toBe(feature);
    expect(await remote.rev('feature')).toBe(theirs);
    expect(result.entry?.title).toBe('Rename feature to topic, here and on origin');
    expect((await ops.undo()).status).toBe('done');
    expect(await local.rev('feature')).toBe(feature);
  });

  it('warns that the remote’s default branch most likely cannot be deleted', async () => {
    await local.git('remote', 'set-head', 'origin', 'main');
    const plan = await ops.plan(rename('main', 'trunk'));
    expect(said(plan, 'warning')).toBe(
      'main is origin’s default branch: the remote will most likely refuse to delete it, leaving origin with both main and trunk.',
    );
    // It does: trunk is published all the same.
    const result = await ops.execute(plan.id);
    expect(result).toMatchObject({
      status: 'failed',
      message:
        'main is renamed to trunk, here and on origin, but origin/main is still there. It is the remote’s current branch, which the remote does not let anyone delete.',
    });
    expect(await onRemote('main')).toBe('main');
    expect(await onRemote('trunk')).toBe('trunk');
    expect(await upstreamOf('trunk')).toBe('refs/remotes/origin/trunk');
  });
});
