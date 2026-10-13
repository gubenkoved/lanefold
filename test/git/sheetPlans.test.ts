import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OperationPlan, PlanNotice } from '../../src/shared/operations';
import { openOps, REBASE_SCRIPT, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

/** The notice that blocks a plan. */
const blocking = (plan: OperationPlan): PlanNotice | undefined =>
  plan.notices.find((notice) => notice.level === 'danger');

describe('what review sheets say (real git)', () => {
  let test: TestRepo;
  let h: OpsHarness;
  let c: { one: string; two: string; three: string; feature: string };

  beforeEach(async () => {
    test = await TestRepo.create();
    const [one, two, three] = await test.commits('one', 'two', 'three');
    await test.checkoutNew('feature', 'HEAD~1');
    const feature = await test.commit('feature work', { files: { 'feature.txt': 'feature\n' } });
    await test.checkout('main');
    c = { one: one!, two: two!, three: three!, feature };
    h = await openOps(test, { rebaseScript: REBASE_SCRIPT });
  });

  afterEach(() => h.dispose());

  it('ties a name problem to its field, and an untouched name is only missing', async () => {
    const empty = await h.ops.plan({ kind: 'createBranch', name: '', at: 'HEAD', checkout: true });
    expect(empty).toMatchObject({ blocked: true, action: 'Create branch', title: 'Create a branch' });
    expect(blocking(empty)).toEqual({
      level: 'danger',
      text: 'Enter a name for the branch.',
      field: 'name',
      missing: true,
    });
    const taken = await h.ops.plan({ kind: 'createBranch', name: 'feature', at: 'HEAD' });
    expect(blocking(taken)).toEqual({
      level: 'danger',
      text: 'A branch named feature already exists.',
      field: 'name',
    });
    // Fixed by typing another name: the form stays usable.
    expect(taken.impossible).toBeUndefined();
    const invalid = await h.ops.plan({ kind: 'createTag', name: 'v1..2', at: 'HEAD' });
    expect(blocking(invalid)).toMatchObject({ text: 'Name cannot contain “..”.', field: 'name' });
  });

  it('an untouched rename says where the name goes, not the same name twice', async () => {
    const plan = await h.ops.plan({ kind: 'renameBranch', from: 'feature', to: 'feature' });
    expect(plan.title).toBe('Rename feature');
    expect(plan.summary).toBe('Rename feature to … (its reflog and upstream come along).');
    expect(plan.commands[0]!.args).toEqual(['branch', '-m', '--end-of-options', 'feature', '']);
    expect(blocking(plan)).toMatchObject({ field: 'to', missing: true });
    expect(plan.action).toBe('Rename');
  });

  it('a merge the branch already has is impossible whatever the form says; names over hashes', async () => {
    const contained = await h.ops.plan({ kind: 'merge', source: c.two, strategy: 'auto' });
    expect(contained).toMatchObject({ blocked: true, impossible: true, title: 'Merge “two” into main' });
    expect(blocking(contained)?.field).toBeUndefined();
    // A commit a branch points at is named by the branch.
    const merge = await h.ops.plan({ kind: 'merge', source: c.feature, strategy: 'no-ff' });
    expect(merge).toMatchObject({ title: 'Merge feature into main', action: 'Merge' });
    expect(merge.impossible).toBeUndefined();
    // Typographic quotes in the flag meanings.
    expect(merge.commands[0]!.flags.map((flag) => flag.meaning)).toContain(
      'use the default “Merge … into main” message',
    );
    // A strategy that cannot work here is a block the form can fix (another strategy).
    const ffOnly = await h.ops.plan({ kind: 'merge', source: 'feature', strategy: 'ff-only' });
    expect(ffOnly.blocked).toBe(true);
    expect(ffOnly.impossible).toBeUndefined();
  });

  it('titles name commits by their subject or a branch, and buttons by their verb', async () => {
    expect(await h.ops.plan({ kind: 'revert', commits: [c.three] })).toMatchObject({
      title: 'Revert “three”',
      action: 'Revert',
    });
    expect(await h.ops.plan({ kind: 'cherryPick', commits: [c.feature] })).toMatchObject({
      title: 'Cherry-pick “feature work” onto main',
      action: 'Cherry-pick',
    });
    expect(await h.ops.plan({ kind: 'checkout', target: c.two, detach: true })).toMatchObject({
      title: 'Check out “two”',
      action: 'Check out',
    });
    expect(await h.ops.plan({ kind: 'reset', to: c.one, mode: 'mixed' })).toMatchObject({
      title: 'Reset main to “one”',
      action: 'Reset main',
    });
    expect(await h.ops.plan({ kind: 'reset', to: 'feature', mode: 'keep' })).toMatchObject({
      title: 'Reset main to feature',
    });
    await test.write('file-1.txt', 'staged\n');
    await test.git('add', 'file-1.txt');
    expect(await h.ops.plan({ kind: 'amendInto', commit: c.two })).toMatchObject({
      title: 'Amend “two” with the staged changes',
      action: 'Amend',
      risk: 'Rewrites commits',
    });
    expect(await h.ops.plan({ kind: 'deleteBranch', name: 'feature' })).toMatchObject({
      action: 'Delete branch',
    });
  });

  it('a destructive plan says how in its badge', async () => {
    await test.write('file-1.txt', 'edited\n');
    const hard = await h.ops.plan({ kind: 'reset', to: c.one, mode: 'hard' });
    expect(hard).toMatchObject({ destructive: true, risk: 'Leaves commits behind · Discards changes' });
    const deleted = await h.ops.plan({ kind: 'deleteBranch', name: 'feature' });
    expect(deleted).toMatchObject({ destructive: true, risk: 'Leaves commits behind' });
    const rebase = await h.ops.plan({ kind: 'rebase', onto: 'feature' });
    expect(rebase).toMatchObject({ destructive: true, risk: 'Rewrites commits', action: 'Rebase' });
    const discard = await h.ops.plan({ kind: 'discard', paths: ['file-1.txt'] });
    expect(discard).toMatchObject({ risk: 'Discards changes', action: 'Discard' });
  });

  it('confirmations say what was done; Undo can be redone, and Redo undone', async () => {
    const tip = await test.rev('feature');
    const deleted = await h.run({ kind: 'deleteBranch', name: 'feature', force: true });
    expect(deleted).toMatchObject({
      status: 'done',
      title: 'Delete branch feature',
      outcome: 'Deleted branch feature',
      message: `feature was at ${tip.slice(0, 8)}`,
    });
    const undone = await h.ops.undo();
    expect(undone).toMatchObject({
      status: 'done',
      outcome: 'Undid “Delete branch feature”',
      redoable: true,
    });
    const redone = await h.ops.redo();
    expect(redone).toMatchObject({ status: 'done', outcome: 'Redid “Delete branch feature”' });
    expect(redone.entry?.title).toBe('Delete branch feature');
  });

  it('a checkout that leaves HEAD on no branch says so, and a plain switch needs no words', async () => {
    const detached = await h.run({ kind: 'checkout', target: c.two, detach: true });
    expect(detached).toMatchObject({ outcome: 'Checked out “two”', detached: c.two });
    const back = await h.run({ kind: 'checkout', target: 'main' });
    expect(back).toMatchObject({ outcome: 'Checked out main', message: '' });
    expect(back.detached).toBeUndefined();
  });

  it('a history edit counts its commits in words', async () => {
    const range = await h.ops.rewriteRange(c.two);
    const result = await h.run({
      kind: 'rewrite',
      base: c.two,
      entries: range!.commits.map((commit) => ({ sha: commit.sha, action: 'reword', message: 'Three' })),
    });
    expect(result).toMatchObject({ status: 'done', outcome: 'Edited history of main' });
    expect(result.message).toMatch(/^1 commit → 1 · main → [0-9a-f]{8}$/);
  });

  describe('a branch checked out in another worktree', () => {
    let folder: string;

    beforeEach(async () => {
      folder = await mkdtemp(join(tmpdir(), 'lanefold-worktree-'));
      await test.git('worktree', 'add', '-q', join(folder, 'feature'), 'feature');
    });

    afterEach(() => rm(folder, { recursive: true, force: true }));

    it('is not checked out, moved or deleted here: its worktree is the way on', async () => {
      const where = join(folder, 'feature');
      for (const operation of [
        { kind: 'checkout', target: 'feature' },
        { kind: 'deleteBranch', name: 'feature' },
        { kind: 'moveBranch', name: 'feature', to: 'main' },
      ] as const) {
        const plan = await h.ops.plan(operation);
        expect(plan, operation.kind).toMatchObject({ blocked: true, impossible: true, worktree: where });
        expect(blocking(plan)?.text).toMatch(
          new RegExp(
            `^feature is checked out in another worktree, ${where.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\. `,
          ),
        );
      }
      // A rename follows it there (git moves that worktree's HEAD along).
      expect((await h.ops.plan({ kind: 'renameBranch', from: 'feature', to: 'topic' })).blocked).toBeFalsy();
    });
  });
});

describe('pulling with a rebase (real git)', () => {
  let remote: TestRepo;
  let local: TestRepo;
  let otherDir: string;
  let h: OpsHarness;

  beforeEach(async () => {
    remote = await TestRepo.create({ bare: true });
    local = await TestRepo.create();
    await local.commits('one', 'two');
    await local.addRemote('origin', remote);
    await local.git('push', '-q', '-u', 'origin', 'main');
    await local.commit('local work');
    otherDir = await mkdtemp(join(tmpdir(), 'lanefold-other-'));
    execFileSync('git', ['clone', '-q', remote.path, join(otherDir, 'clone')], {
      env: { ...process.env, ...local.env },
    });
    h = await openOps(local);
  });

  afterEach(async () => {
    await h.dispose();
    await remote.dispose();
    await rm(otherDir, { recursive: true, force: true });
  });

  it('with nothing incoming yet, says what may happen and is no rewrite', async () => {
    const plan = await h.ops.plan({ kind: 'pull', mode: 'rebase' });
    expect(plan.destructive).toBe(false);
    expect(plan.notices.map((notice) => notice.text)).toContain(
      'If new commits come in, your 1 local commit is replayed on top of them and gets a new hash. Undo puts main back.',
    );
    expect(plan.changes).toEqual([
      { ref: 'refs/heads/main', from: await local.rev('main'), toNew: 'any new commits' },
    ]);
  });

  /** A commit pushed to origin/main from another clone, writing `file`. */
  function pushFromElsewhere(file: string): void {
    const clone = join(otherDir, 'clone');
    const other = (...args: string[]) =>
      execFileSync('git', ['-C', clone, '-c', 'user.name=Bob', '-c', 'user.email=bob@x', ...args], {
        env: { ...process.env, ...local.env },
      });
    execFileSync('sh', ['-c', `echo elsewhere > "${join(clone, file)}"`]);
    other('add', file);
    other('commit', '-qm', 'From elsewhere');
    other('push', '-q', 'origin', 'main');
  }

  it('with commits incoming, says the local ones get new hashes', async () => {
    pushFromElsewhere('elsewhere.txt');
    await local.git('fetch', '-q');
    const plan = await h.ops.plan({ kind: 'pull', mode: 'rebase' });
    expect(plan).toMatchObject({ destructive: true, risk: 'Rewrites commits', action: 'Pull' });
    expect(plan.notices.map((notice) => notice.text)).toContain(
      'Your 1 local commit is replayed on top of the incoming ones and gets a new hash. Undo puts main back.',
    );
  });

  it('a pull stopped on a conflict is named as the pull, and so is its abort', async () => {
    // The local commit wrote file-3.txt; so does the one from elsewhere.
    pushFromElsewhere('file-3.txt');
    const stopped = await h.run({ kind: 'pull', mode: 'rebase' });
    expect(stopped.status).toBe('conflicts');
    expect((await h.ops.opState()).started).toEqual({ kind: 'pull', title: 'Pull main' });
    const abort = await h.ops.plan({ kind: 'abort' });
    expect(abort.title).toBe('Abort the pull');
    expect(abort.commands[0]!.explanation).toBe(
      'Stop the pull and put everything back as it was before it started.',
    );
  });
});
