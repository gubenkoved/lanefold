import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RepoOperations } from '../../src/core/ops/operations';
import { readRefState } from '../../src/core/ops/refState';
import { KEEP_REFS, takeSnapshot } from '../../src/core/ops/snapshot';
import { RepoData } from '../../src/core/repo/repoData';
import { Repository } from '../../src/core/repo/repository';
import type { RewriteEntry } from '../../src/shared/rewrite';
import { openOps, REBASE_SCRIPT, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

/** The safety review's scenarios: each one used to lose work, or let Undo take other work away. */
describe('safety (real git)', () => {
  let test: TestRepo;
  let repo: Repository;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];
  let commits: string[];

  beforeEach(async () => {
    test = await TestRepo.create();
    commits = [
      await test.commit('base', { files: { 'a.txt': 'a\n', 'shared.txt': 'base\n' } }),
      await test.commit('one', { files: { 'one.txt': 'one\n' } }),
      await test.commit('two', { files: { 'two.txt': 'two\n' } }),
      await test.commit('three', { files: { 'three.txt': 'three\n' } }),
    ];
    ({ repo, ops, run, dispose } = await openOps(test, { rebaseScript: REBASE_SCRIPT }));
  });

  afterEach(() => dispose());

  const read = (file: string) => readFile(join(test.path, file), 'utf8');
  const stashes = () => test.git('stash', 'list', '--format=%gs');

  /** Stops a history edit at `two` (an edit line). */
  async function stopAtEdit(): Promise<void> {
    const [base, one, two, three] = commits;
    const entries: RewriteEntry[] = [
      { sha: one!, action: 'pick' },
      { sha: two!, action: 'edit' },
      { sha: three!, action: 'pick' },
    ];
    expect(await run({ kind: 'rewrite', base: base!, entries })).toMatchObject({ status: 'stopped' });
  }

  /** Stops a merge on a conflict in shared.txt. */
  async function stopOnConflict(): Promise<void> {
    await test.checkoutNew('side', commits[0]);
    await test.commit('side edit', { files: { 'shared.txt': 'side\n' } });
    await test.checkout('main');
    await test.commit('main edit', { files: { 'shared.txt': 'main\n' } });
    expect(await run({ kind: 'merge', source: 'side', strategy: 'auto' })).toMatchObject({
      status: 'conflicts',
    });
  }

  it('aborting at an edit stop keeps the edits made there, as a stash', async () => {
    await stopAtEdit();
    await test.write('two.txt', 'edited while stopped\n');
    const plan = await ops.plan({ kind: 'abort' });
    expect(plan.destructive).toBe(true);
    expect(plan.notices.map((n) => n.text).join('\n')).toMatch(/saves them as a stash/);

    const result = await ops.execute(plan.id);
    expect(result.status).toBe('done');
    expect(result.message).toMatch(/saved as stash@\{0\}/);
    expect((await ops.opState()).kind).toBeUndefined();
    expect(await read('two.txt')).toBe('two\n');
    expect(await stashes()).toMatch(/changes saved before/);
    await test.git('stash', 'apply');
    expect(await read('two.txt')).toBe('edited while stopped\n');
  });

  it('aborting after resolving a conflict keeps the resolution, as a stash', async () => {
    await stopOnConflict();
    await writeFile(join(test.path, 'shared.txt'), 'hand-merged\n');
    await test.git('add', 'shared.txt');
    const result = await run({ kind: 'abort' });
    expect(result.message).toMatch(/saved as stash@\{0\}/);
    expect(await read('shared.txt')).toBe('main\n');
    await test.git('stash', 'apply');
    expect(await read('shared.txt')).toBe('hand-merged\n');
  });

  it('aborting a stop nobody touched saves nothing and needs no review', async () => {
    await stopOnConflict();
    const plan = await ops.plan({ kind: 'abort' });
    expect(plan.destructive).toBe(false);
    expect((await ops.execute(plan.id)).message).not.toMatch(/stash/);
    expect(await stashes()).toBe('');
  });

  it('skipping at an edit stop says what it does and keeps the edits', async () => {
    await stopAtEdit();
    await test.write('extra.txt', 'new while stopped\n');
    await test.git('add', 'extra.txt');
    const plan = await ops.plan({ kind: 'skip' });
    expect(plan.commands[0]!.explanation).toMatch(/it stays as it is/);
    expect(plan.destructive).toBe(true);
    const result = await ops.execute(plan.id);
    expect(result.message).toMatch(/saved as stash@\{0\}/);
    expect(existsSync(join(test.path, 'extra.txt'))).toBe(false);
    expect(await test.log('HEAD')).toEqual(['three', 'two', 'one', 'base']);
  });

  it('a hard reset keeps files saved after it was planned: Undo brings them back', async () => {
    const plan = await ops.plan({ kind: 'reset', to: 'HEAD', mode: 'hard' });
    expect(plan.destructive).toBe(false); // clean when planned
    await test.write('a.txt', 'saved after the plan\n');
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await read('a.txt')).toBe('a\n');
    expect((await ops.undo()).status).toBe('done');
    expect(await read('a.txt')).toBe('saved after the plan\n');
  });

  it('keeps the snapshots Undo needs with refs, and lets go of them when no entry needs them', async () => {
    await test.write('a.txt', 'work\n');
    await run({ kind: 'reset', to: 'HEAD~1', mode: 'hard' });
    const keep = async () =>
      (await test.git('for-each-ref', '--format=%(refname)', KEEP_REFS)).split('\n').filter(Boolean);
    await expect.poll(keep).toHaveLength(1);
    // Undone, the entry can be redone: still needed.
    await ops.undo();
    await expect.poll(keep).toHaveLength(1);
    // A new operation clears Redo: nothing needs the snapshot any more.
    await run({ kind: 'createBranch', name: 'x', at: 'HEAD' });
    await expect.poll(keep).toHaveLength(0);
  });

  it('refuses an Undo whose snapshot is gone, and leaves the refs alone', async () => {
    await test.write('a.txt', 'work\n');
    await run({ kind: 'reset', to: 'HEAD~1', mode: 'hard' });
    const before = await readRefState(repo);
    const keepRefs = (await test.git('for-each-ref', '--format=%(refname)', KEEP_REFS)).split('\n');
    for (const ref of [...keepRefs.filter(Boolean), 'refs/lanefold/backup'])
      await test.git('update-ref', '-d', ref);
    await test.git('reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all');
    await test.git('gc', '--prune=now', '--quiet');
    expect(await ops.undo()).toMatchObject({ status: 'refused', errorKind: 'snapshotGone' });
    expect(await readRefState(repo)).toEqual(before);
  });

  it('a snapshot never records HEAD for the index when git cannot write it (a lock)', async () => {
    await test.write('a.txt', 'staged\n');
    await test.git('add', 'a.txt');
    await writeFile(join(test.path, '.git', 'index.lock'), '');
    // write-tree needs the lock; only a conflict (unmerged entries) may stand in HEAD's tree.
    await expect(takeSnapshot(repo, 'test')).rejects.toThrow(/index\.lock/);
  });

  it('a snapshot during a conflict keeps the working tree, with HEAD standing in for the index', async () => {
    await stopOnConflict();
    await writeFile(join(test.path, 'shared.txt'), 'half resolved\n');
    const snapshot = await takeSnapshot(repo, 'test');
    expect(await test.git('show', `${snapshot}:shared.txt`)).toBe('half resolved');
    expect(await test.git('rev-parse', `${snapshot}^1^{tree}`)).toBe(
      await test.git('rev-parse', 'HEAD^{tree}'),
    );
  });

  it('Undo leaves a branch alone that is checked out in another worktree', async () => {
    await run({ kind: 'createBranch', name: 'topic', at: 'HEAD~1' });
    await test.git('worktree', 'add', '-q', join(test.path, '..', `wt-${Date.now()}`), 'topic');
    expect(await ops.undo()).toMatchObject({ status: 'refused', errorKind: 'branchInWorktree' });
    expect(await test.rev('topic')).toBe(commits[2]);
  });

  it('refuses a merge whose source moved since it was planned (a fetch)', async () => {
    await test.git('update-ref', 'refs/remotes/origin/side', commits[1]!);
    await test.checkoutNew('older', commits[0]);
    const plan = await ops.plan({ kind: 'merge', source: 'origin/side', strategy: 'auto' });
    await test.git('update-ref', 'refs/remotes/origin/side', commits[3]!);
    expect(await ops.execute(plan.id)).toMatchObject({ status: 'refused', errorKind: 'stale' });
    expect(await test.rev('HEAD')).toBe(commits[0]);
  });

  it('undoing a commit made in detached HEAD brings its changes back', async () => {
    await test.git('switch', '-q', '--detach', 'HEAD');
    await test.write('detached.txt', 'made detached\n');
    await test.git('add', 'detached.txt');
    expect((await run({ kind: 'commit', message: 'detached work' })).status).toBe('done');
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(commits[3]);
    expect(await read('detached.txt')).toBe('made detached\n');
    expect(await test.git('status', '--porcelain')).toBe('A  detached.txt');
  });

  it('restoring a file over an ignored local copy keeps that copy for Undo', async () => {
    await test.commit('tracked once', { files: { 'settings.local.json': '{"old": true}\n' } });
    const old = await test.rev('HEAD');
    await test.git('rm', '-q', '--cached', 'settings.local.json');
    await test.commit('ignore it', { files: { '.gitignore': 'settings.local.json\n' } });
    await test.write('settings.local.json', '{"mine": true}\n');
    const plan = await ops.plan({ kind: 'restoreFiles', source: old, paths: ['settings.local.json'] });
    expect(plan.destructive).toBe(true);
    await ops.execute(plan.id);
    expect(await read('settings.local.json')).toBe('{"old": true}\n');
    expect((await ops.undo()).status).toBe('done');
    expect(await read('settings.local.json')).toBe('{"mine": true}\n');
  });

  it('checking out a commit that tracks an ignored local file keeps that file for Undo', async () => {
    await test.commit('tracked once', { files: { '.env': 'OLD=1\n' } });
    const old = await test.rev('HEAD');
    await test.git('rm', '-q', '--cached', '.env');
    await test.commit('ignore it', { files: { '.gitignore': '.env\n' } });
    await test.write('.env', 'SECRET=mine\n');
    const plan = await ops.plan({ kind: 'checkout', target: old, detach: true });
    expect(plan.destructive).toBe(true);
    expect(plan.notices.map((n) => n.text).join('\n')).toMatch(/\.env is ignored here but tracked there/);
    await ops.execute(plan.id);
    expect(await read('.env')).toBe('OLD=1\n');
    expect((await ops.undo()).status).toBe('done');
    expect(await test.git('branch', '--show-current')).toBe('main');
    expect(await read('.env')).toBe('SECRET=mine\n');
  });

  it('taking a side checks the file is conflicted and keeps an edited version as .orig', async () => {
    await stopOnConflict();
    await expect(ops.resolveConflict('a.txt', 'theirs')).rejects.toThrow(/not conflicted/);
    await expect(ops.resolveConflict('shared.txt', 'force' as 'ours')).rejects.toThrow(/Unknown side/);
    // Untouched since git stopped: nothing to keep.
    expect(await ops.resolveConflict('shared.txt', 'theirs')).toEqual({ backup: undefined });
    expect(await read('shared.txt')).toBe('side\n');
    await writeFile(join(test.path, 'shared.txt'), 'my careful resolution\n');
    expect(await ops.resolveConflict('shared.txt', 'markers')).toEqual({ backup: 'shared.txt.orig' });
    expect(await read('shared.txt.orig')).toBe('my careful resolution\n');
    expect(await read('shared.txt')).toContain('<<<<<<<');
  });

  it('plans amending a root commit that was already pushed', async () => {
    const root = await TestRepo.create();
    try {
      await root.commit('only');
      await root.git('remote', 'add', 'origin', root.path);
      await root.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      await root.git('config', 'branch.main.remote', 'origin');
      await root.git('config', 'branch.main.merge', 'refs/heads/main');
      const rootRepo = (await Repository.open(root.runner, root.path))!;
      const rootData = new RepoData(rootRepo);
      const rootOps = new RepoOperations(rootRepo, rootData);
      const plan = await rootOps.plan({ kind: 'commit', message: 'reworded', amend: true });
      expect(plan.blocked).toBeFalsy();
      expect(plan.notices.map((n) => n.text).join('\n')).toMatch(/already on origin\/main/);
      rootOps.dispose();
      rootData.dispose();
    } finally {
      await root.dispose();
    }
  });

  it('deletes with -d only what git agrees is merged (into the upstream, when there is one)', async () => {
    await test.branch('topic', 'HEAD~1');
    // Merged into HEAD, but its upstream lacks it: git would refuse -d.
    await test.git('remote', 'add', 'origin', test.path);
    await test.git('update-ref', 'refs/remotes/origin/topic', commits[0]!);
    await test.git('config', 'branch.topic.remote', 'origin');
    await test.git('config', 'branch.topic.merge', 'refs/heads/topic');
    const plan = await ops.plan({ kind: 'deleteBranch', name: 'topic' });
    expect(plan.commands[0]!.args).toEqual(['branch', '-D', '--end-of-options', 'topic']);
    expect((await ops.execute(plan.id)).status).toBe('done');
  });

  describe('a stopped operation is only ever finished as itself', () => {
    it('a rebase aborted outside Lanefold is forgotten; a later rebase is not journaled as it', async () => {
      await stopAtEdit();
      await test.git('rebase', '--abort');
      // A week of other work, then a rebase in a terminal.
      await test.git('branch', 'later');
      await test.tag('v1');
      await test.checkoutNew('upstream', commits[0]);
      await test.commit('upstream work', { files: { 'up.txt': 'up\n' } });
      await test.checkout('main');
      await test.git('rebase', '-q', 'upstream');
      await ops.opState();
      expect(ops.undoInfo.undo).toBeUndefined();
    });

    it('a history edit continued in a terminal is still one undoable step', async () => {
      await stopAtEdit();
      await test.write('extra.txt', 'amended in\n');
      await test.git('add', 'extra.txt');
      await test.git('-c', 'core.editor=true', 'rebase', '--continue');
      await ops.opState();
      expect(ops.undoInfo.undo).toBe('Edit history of main');
      expect((await ops.undo()).status).toBe('done');
      expect(await test.rev('main')).toBe(commits[3]);
    });

    it('when it finishes through Lanefold, Undo restores the branch only, not refs made meanwhile', async () => {
      await stopAtEdit();
      await test.tag('made-while-stopped');
      const continued = await run({ kind: 'continue' });
      expect(continued.status).toBe('done');
      expect((await ops.undo()).status).toBe('done');
      expect(await test.rev('main')).toBe(commits[3]);
      expect(await test.git('tag', '--list', 'made-while-stopped')).toBe('made-while-stopped');
    });

    it('Continue on a different merge started in a terminal does not finish the old record', async () => {
      await stopOnConflict();
      await test.git('merge', '--abort');
      await test.checkoutNew('other', commits[0]);
      await test.commit('other edit', { files: { 'shared.txt': 'other\n' } });
      await test.checkout('main');
      await test.git('merge', 'other').catch(() => undefined);
      await writeFile(join(test.path, 'shared.txt'), 'resolved\n');
      await test.git('add', 'shared.txt');
      const mainBefore = await test.rev('main');
      const result = await run({ kind: 'continue' });
      expect(result.status).toBe('done');
      // Not "Merge side into main" with that merge's starting point: it was aborted.
      expect(result.entry?.title).toBe('Conclude the merge');
      expect((await ops.undo()).status).toBe('done');
      expect(await test.rev('main')).toBe(mainBefore);
    });
  });
});
