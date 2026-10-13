import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conflictStages } from '../../src/core/ops/opState';
import type { RepoOperations } from '../../src/core/ops/operations';
import { readRefState } from '../../src/core/ops/refState';
import { BACKUP_REF } from '../../src/core/ops/snapshot';
import type { Repository } from '../../src/core/repo/repository';
import type { Operation } from '../../src/shared/operations';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { BOB, TestRepo } from '../fixtures/repoBuilder';

describe('RepoOperations (real git)', () => {
  let test: TestRepo;
  let repo: Repository;
  let ops: RepoOperations;
  /** Runs plans as they are: some here are meant to be refused. */
  let run: OpsHarness['attempt'];
  let dispose: OpsHarness['dispose'];

  beforeEach(async () => {
    test = await TestRepo.create();
    await test.commits('one', 'two', 'three');
    await test.branch('feature', 'HEAD~1');
    await test.checkout('feature');
    await test.commit('feature work', { files: { 'feature.txt': 'feature\n' } });
    await test.checkout('main');
    ({ repo, ops, attempt: run, dispose } = await openOps(test));
  });

  afterEach(() => dispose());

  it('creates a branch, undoes and redoes it exactly', async () => {
    const before = await readRefState(repo);
    const result = await run({ kind: 'createBranch', name: 'topic', at: 'HEAD~1', checkout: true });
    expect(result.status).toBe('done');
    expect(await test.git('branch', '--show-current')).toBe('topic');
    expect(await test.rev('topic')).toBe(await test.rev('main~1'));

    expect((await ops.undo()).status).toBe('done');
    expect(await readRefState(repo)).toEqual(before);
    expect(await test.git('branch', '--show-current')).toBe('main');

    expect((await ops.redo()).status).toBe('done');
    expect(await test.git('branch', '--show-current')).toBe('topic');
    expect(ops.undoInfo).toEqual({ undo: 'Create branch topic', redo: undefined });
  });

  it('refuses to run a plan when the repository changed after planning', async () => {
    const plan = await ops.plan({ kind: 'reset', to: 'HEAD~1', mode: 'keep' });
    await test.commit('made elsewhere');
    const result = await ops.execute(plan.id);
    expect(result).toMatchObject({ status: 'refused', errorKind: 'stale' });
    expect(await test.log('main', '%s')).toContain('made elsewhere');
  });

  it('reports commits a reset leaves behind and undoes the reset', async () => {
    const head = await test.rev('HEAD');
    const plan = await ops.plan({ kind: 'reset', to: 'HEAD~2', mode: 'keep' });
    // "three" is only on main; "two" is also on feature.
    expect(plan.orphaned).toBe(1);
    expect(plan.destructive).toBe(true);
    expect(plan.commands.map((c) => c.args.slice(0, 2))).toEqual([['reset', '--keep']]);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await test.rev('main')).toBe(await test.rev(`${head}~2`));
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('main')).toBe(head);
  });

  it('snapshots uncommitted work before reset --hard and restores it on undo', async () => {
    await test.write('file-1.txt', 'staged edit\n');
    await test.git('add', 'file-1.txt');
    await test.write('file-2.txt', 'unstaged edit\n');
    await test.write('notes/new.txt', 'untracked\n');
    const status = await test.git('status', '--porcelain=v1', '--untracked-files=all');

    const plan = await ops.plan({ kind: 'reset', to: 'HEAD', mode: 'hard' });
    expect(plan.destructive).toBe(true);
    expect(plan.notices.some((n) => n.level === 'danger' && /discarded/.test(n.text))).toBe(true);
    const result = await ops.execute(plan.id);
    expect(result, result.message).toMatchObject({ status: 'done' });
    expect(result.entry?.snapshot).toBeDefined();
    expect(await test.git('rev-parse', BACKUP_REF)).toBe(result.entry!.snapshot);
    // Gone from the working tree (untracked files survive a hard reset, edits do not).
    expect(await readFile(join(test.path, 'file-2.txt'), 'utf8')).toBe('two\n');

    expect((await ops.undo()).status).toBe('done');
    expect(await readFile(join(test.path, 'file-1.txt'), 'utf8')).toBe('staged edit\n');
    expect(await readFile(join(test.path, 'file-2.txt'), 'utf8')).toBe('unstaged edit\n');
    expect(await readFile(join(test.path, 'notes/new.txt'), 'utf8')).toBe('untracked\n');
    // Staged stays staged, unstaged stays unstaged.
    expect(await test.git('status', '--porcelain=v1', '--untracked-files=all')).toBe(status);
  });

  it('refuses to undo when the repository moved on since the operation', async () => {
    await run({ kind: 'reset', to: 'HEAD~1', mode: 'keep' });
    await test.commit('newer work');
    const result = await ops.undo();
    expect(result).toMatchObject({ status: 'refused', errorKind: 'stale' });
    expect(await test.log('main', '%s')).toContain('newer work');
  });

  it('merges with a merge commit, predicts conflicts, and undoes', async () => {
    const plan = await ops.plan({ kind: 'merge', source: 'feature', strategy: 'no-ff' });
    expect(plan.conflicts).toEqual({ predicted: false, files: [] });
    expect(plan.commands[0]!.args).toEqual(['merge', '--no-ff', '--no-edit', 'feature']);
    const head = await test.rev('main');
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await test.git('rev-list', '--parents', '-n1', 'main')).toContain(await test.rev('feature'));
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('main')).toBe(head);
  });

  it('stops on conflicts, blocks other operations, and aborts cleanly', async () => {
    await test.checkout('feature');
    await test.commit('feature edits', { files: { 'shared.txt': 'feature side\n' } });
    await test.checkout('main');
    await test.commit('main edits', { files: { 'shared.txt': 'main side\n' } });
    const head = await test.rev('main');

    const plan = await ops.plan({ kind: 'merge', source: 'feature', strategy: 'auto' });
    expect(plan.conflicts).toEqual({ predicted: true, files: ['shared.txt'] });
    const result = await ops.execute(plan.id);
    expect(result).toMatchObject({ status: 'conflicts', conflicts: ['shared.txt'] });
    expect(await ops.opState()).toMatchObject({ kind: 'merge', conflicts: ['shared.txt'] });

    const blocked = await ops.plan({ kind: 'createBranch', name: 'x', at: 'HEAD' });
    expect(blocked.blocked).toBe(true);
    expect((await ops.plan({ kind: 'continue' })).blocked).toBe(true); // unresolved conflicts

    const abort = await run({ kind: 'abort' });
    expect(abort.status).toBe('done');
    expect((await ops.opState()).kind).toBeUndefined();
    expect(await test.rev('main')).toBe(head);
    expect(await test.git('status', '--porcelain')).toBe('');
  });

  it('continues a merge after the conflicts are resolved', async () => {
    await test.checkout('feature');
    await test.commit('feature edits', { files: { 'shared.txt': 'feature side\n' } });
    await test.checkout('main');
    await test.commit('main edits', { files: { 'shared.txt': 'main side\n' } });
    await run({ kind: 'merge', source: 'feature', strategy: 'auto' });
    await writeFile(join(test.path, 'shared.txt'), 'resolved\n');
    await test.git('add', 'shared.txt');
    const result = await run({ kind: 'continue' });
    expect(result.status).toBe('done');
    expect(await test.log('main', '%s')).toContain("Merge branch 'feature'");
  });

  it('names the sides of a merge and concludes it with a message of your own', async () => {
    await test.checkout('feature');
    await test.commit('feature edits', { files: { 'shared.txt': 'feature side\n' } });
    await test.checkout('main');
    await test.commit('main edits', { files: { 'shared.txt': 'main side\n' } });
    await run({ kind: 'merge', source: 'feature', strategy: 'auto' });
    const state = await ops.opState();
    expect(state).toMatchObject({ kind: 'merge', branch: 'main', incomingRef: 'feature' });
    // Git's prepared message, without its "# Conflicts:" comment lines.
    expect(state.message).toBe("Merge branch 'feature'");
    // Both branches added the file: there is no merge base (stage 1), only the two sides.
    expect(await conflictStages(repo, 'shared.txt')).toEqual(new Set([2, 3]));

    await writeFile(join(test.path, 'shared.txt'), 'resolved\n');
    await test.git('add', 'shared.txt');
    // A message for anything but a merge is refused; an empty one too.
    expect((await ops.plan({ kind: 'continue', message: '  ' })).blocked).toBe(true);
    const plan = await ops.plan({ kind: 'continue', message: 'Bring in the feature\n\nResolved by hand.' });
    expect(plan.title).toBe('Conclude the merge');
    expect(plan.commands.map((command) => command.args.slice(0, 2))).toEqual([['commit', '-m']]);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await test.git('log', '-1', '--format=%B', 'main')).toBe(
      'Bring in the feature\n\nResolved by hand.',
    );
    expect((await test.git('log', '-1', '--format=%P', 'main')).split(' ')).toHaveLength(2);
  });

  it('shows a rebase stop: the commits replayed, the current one and those to come', async () => {
    await test.checkout('feature');
    await test.commit('feature 2', { files: { 'shared.txt': 'feature side\n' } });
    await test.commit('feature 3', { files: { 'other.txt': 'more\n' } });
    await test.checkout('main');
    await test.commit('main edits', { files: { 'shared.txt': 'main side\n' } });
    await test.checkout('feature');
    const [first, second, third] = (await test.git('rev-list', '--reverse', 'main..feature')).split('\n');
    await test.git('rebase', 'main').catch(() => undefined);
    const state = await ops.opState();
    expect(state).toMatchObject({ kind: 'rebase', branch: 'feature', ontoRef: 'main', commit: second });
    expect(state.steps).toEqual({ done: [first, second], todo: [third] });
    await run({ kind: 'abort' });
  });

  it('sets your name and email, even in the middle of a merge, without journaling it', async () => {
    await test.checkout('feature');
    await test.commit('feature edits', { files: { 'shared.txt': 'feature side\n' } });
    await test.checkout('main');
    await test.commit('main edits', { files: { 'shared.txt': 'main side\n' } });
    await run({ kind: 'merge', source: 'feature', strategy: 'auto' });
    expect((await ops.opState()).kind).toBe('merge');

    expect((await ops.plan({ kind: 'setIdentity', name: '', email: 'x', global: false })).blocked).toBe(true);
    expect(
      (await ops.plan({ kind: 'setIdentity', name: 'Ada', email: 'not an email', global: false })).blocked,
    ).toBe(true);
    const plan = await ops.plan({
      kind: 'setIdentity',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      global: false,
    });
    expect(plan.blocked).toBeFalsy();
    expect(plan.commands.map((command) => command.args)).toEqual([
      ['config', 'user.name', 'Ada Lovelace'],
      ['config', 'user.email', 'ada@example.com'],
    ]);
    const result = await ops.execute(plan.id);
    expect(result.status).toBe('done');
    expect(result.entry).toBeUndefined();
    expect(await test.git('config', '--local', 'user.email')).toBe('ada@example.com');
    await run({ kind: 'abort' });
  });

  describe('carrying uncommitted changes to another branch (smart checkout)', () => {
    const lines = (...edits: [number, string][]) => {
      const text = ['one', 'two', 'three', 'four', 'five'];
      for (const [index, line] of edits) text[index] = line;
      return `${text.join('\n')}\n`;
    };

    beforeEach(async () => {
      await test.commit('shared', { files: { 'shared.txt': lines() } });
      await test.git('branch', '-f', 'feature', 'HEAD');
      await test.checkout('feature');
      await test.commit('feature edits the last line', { files: { 'shared.txt': lines([4, 'FIVE']) } });
      await test.checkout('main');
    });

    it('says which changes are in the way, carries them over, and Undo puts everything back exactly', async () => {
      await writeFile(join(test.path, 'shared.txt'), lines([0, 'ONE']));
      await writeFile(join(test.path, 'staged.txt'), 'staged\n');
      await test.git('add', 'staged.txt');
      const before = await readRefState(repo);
      const status = await test.git('status', '--porcelain');

      const blocked = await ops.plan({ kind: 'checkout', target: 'feature' });
      expect(blocked.blocked).toBe(true);
      expect(blocked.carryOver).toEqual({ files: ['shared.txt'] });

      const plan = await ops.plan({ kind: 'checkout', target: 'feature', carry: true });
      expect(plan.blocked).toBeFalsy();
      expect(plan.commands.map((command) => command.args.slice(0, 2).join(' '))).toEqual([
        'stash push',
        'switch --end-of-options',
        'stash pop',
      ]);
      const result = await ops.execute(plan.id);
      expect(result.status).toBe('done');
      expect(await test.git('branch', '--show-current')).toBe('feature');
      // Both edits: the branch's and the carried one, and what was staged is still staged.
      expect(await readFile(join(test.path, 'shared.txt'), 'utf8')).toBe(lines([0, 'ONE'], [4, 'FIVE']));
      expect(await test.git('diff', '--cached', '--name-only')).toBe('staged.txt');
      expect(await test.git('stash', 'list')).toBe('');

      expect((await ops.undo()).status).toBe('done');
      expect(await readRefState(repo)).toEqual(before);
      expect(await readFile(join(test.path, 'shared.txt'), 'utf8')).toBe(lines([0, 'ONE']));
      expect(await test.git('status', '--porcelain')).toBe(status);
    });

    it('stops with conflict markers when the changes clash, keeping them on the stash list', async () => {
      await writeFile(join(test.path, 'shared.txt'), lines([4, 'five (mine)']));
      const result = await run({ kind: 'checkout', target: 'feature', carry: true });
      expect(result).toMatchObject({ status: 'conflicts', conflicts: ['shared.txt'] });
      expect(await test.git('branch', '--show-current')).toBe('feature');
      expect(await test.git('stash', 'list')).toContain('lanefold: carried to feature');
      expect(await readFile(join(test.path, 'shared.txt'), 'utf8')).toContain('<<<<<<<');

      // Undo leaves the conflict behind: back on main with the edit exactly as it was.
      expect((await ops.undo()).status).toBe('done');
      expect(await test.git('branch', '--show-current')).toBe('main');
      expect(await readFile(join(test.path, 'shared.txt'), 'utf8')).toBe(lines([4, 'five (mine)']));
      expect(await test.git('status', '--porcelain')).toBe(' M shared.txt');
    });
  });

  it('refuses to continue a patch that git could not apply', async () => {
    await test.checkout('feature');
    await test.commit('patch me', { files: { 'shared.txt': 'patched\n' } });
    const patch = await test.git('format-patch', '-1', '--stdout');
    await test.checkout('main');
    await test.commit('diverge', { files: { 'shared.txt': 'diverged\n' } });
    await writeFile(join(test.path, '..', 'p.patch'), `${patch}\n`);
    await test.git('am', join(test.path, '..', 'p.patch')).catch(() => undefined);
    const state = await ops.opState();
    expect(state).toMatchObject({ kind: 'am', commitSubject: 'patch me', changes: { staged: 0 } });
    expect((await ops.plan({ kind: 'continue' })).blocked).toBe(true);
    expect((await run({ kind: 'abort' })).status).toBe('done');
  });

  it('cherry-picks and reverts commits, each undoable', async () => {
    const feature = await test.rev('feature');
    const head = await test.rev('main');
    expect((await run({ kind: 'cherryPick', commits: [feature], recordOrigin: true })).status).toBe('done');
    expect(await test.git('log', '-1', '--format=%B', 'main')).toContain(
      `(cherry picked from commit ${feature})`,
    );
    expect((await run({ kind: 'revert', commits: [await test.rev('main')] })).status).toBe('done');
    expect(await test.log('main', '%s')).toContain('Revert "feature work"');
    await ops.undo();
    await ops.undo();
    expect(await test.rev('main')).toBe(head);
  });

  it('leaves commits already on the branch out of a cherry-pick', async () => {
    const feature = await test.rev('feature');
    const onMain = await test.rev('main~1');
    const plan = await ops.plan({ kind: 'cherryPick', commits: [onMain, feature] });
    expect(plan.blocked).toBeFalsy();
    expect(plan.commands[0]!.args).toEqual(['cherry-pick', feature]);
    expect(plan.notices.map((notice) => notice.text)).toContain('1 commit already on main is left out.');
    const only = await ops.plan({ kind: 'cherryPick', commits: [onMain] });
    expect(only.blocked).toBe(true);
    expect(only.notices.map((notice) => notice.text).join('\n')).toContain(
      'is already on main: there is nothing to cherry-pick.',
    );
  });

  it('says what is in the way of a cherry-pick or revert before git refuses', async () => {
    const feature = await test.rev('feature');
    const reasons = async (operation: Operation) => {
      const plan = await ops.plan(operation);
      return { blocked: !!plan.blocked, text: plan.notices.map((notice) => notice.text).join('\n') };
    };
    // Anything staged: git applies commits only onto an index that matches HEAD.
    await test.write('notes.txt', 'unrelated\n');
    await test.git('add', 'notes.txt');
    expect(await reasons({ kind: 'cherryPick', commits: [feature] })).toMatchObject({
      blocked: true,
      text: expect.stringContaining(
        '1 staged file is in the way: git cherry-picks only when nothing is staged',
      ),
    });
    expect((await reasons({ kind: 'revert', commits: [await test.rev('main')] })).text).toContain(
      'git reverts only when nothing is staged',
    );
    // Unstaged and untracked files are fine, unless the commits change them.
    await test.git('reset', '-q');
    expect((await reasons({ kind: 'cherryPick', commits: [feature] })).blocked).toBe(false);
    await test.write('feature.txt', 'mine\n');
    expect(await reasons({ kind: 'cherryPick', commits: [feature] })).toMatchObject({
      blocked: true,
      text: expect.stringContaining('Your uncommitted changes to feature.txt would be overwritten'),
    });
  });

  it('counts commits only a deleted branch holds and brings the branch back on undo', async () => {
    const tip = await test.rev('feature');
    const plan = await ops.plan({ kind: 'deleteBranch', name: 'feature' });
    expect(plan.orphaned).toBe(1);
    expect(plan.destructive).toBe(true);
    expect(plan.commands[0]!.args).toEqual(['branch', '-D', '--end-of-options', 'feature']);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await test.git('branch', '--list', 'feature')).toBe('');
    await ops.undo();
    expect(await test.rev('feature')).toBe(tip);
  });

  it('renames a branch and undoes the rename with its upstream configuration', async () => {
    await test.git('config', 'branch.feature.remote', 'origin');
    await test.git('config', 'branch.feature.merge', 'refs/heads/feature');
    expect((await run({ kind: 'renameBranch', from: 'feature', to: 'topic' })).status).toBe('done');
    expect(await test.git('config', 'branch.topic.remote')).toBe('origin');
    expect((await ops.undo()).status).toBe('done');
    expect(await test.git('branch', '--list', 'topic')).toBe('');
    expect(await test.git('config', 'branch.feature.remote')).toBe('origin');
  });

  it('rebases the current branch and undoes it', async () => {
    await test.checkout('feature');
    const before = await test.rev('feature');
    const plan = await ops.plan({ kind: 'rebase', onto: 'main' });
    expect(plan.commands[0]!.args).toContain('main');
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await test.git('merge-base', '--is-ancestor', 'main', 'feature').then(() => true)).toBe(true);
    await ops.undo();
    expect(await test.rev('feature')).toBe(before);
  });

  it('moves a branch that is not checked out, and moves it back on undo', async () => {
    const tip = await test.rev('feature');
    const plan = await ops.plan({ kind: 'moveBranch', name: 'feature', to: 'main' });
    expect(plan.orphaned).toBe(1); // "feature work" is only on feature
    expect(plan.commands[0]!.args).toEqual([
      'branch',
      '--force',
      '--end-of-options',
      'feature',
      await test.rev('main'),
    ]);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await test.rev('feature')).toBe(await test.rev('main'));
    await ops.undo();
    expect(await test.rev('feature')).toBe(tip);
    expect((await ops.plan({ kind: 'moveBranch', name: 'main', to: 'feature' })).blocked).toBe(true);
  });

  it('creates and deletes tags', async () => {
    expect((await run({ kind: 'createTag', name: 'v1', at: 'HEAD', message: 'First' })).status).toBe('done');
    expect(await test.git('cat-file', '-t', 'v1')).toBe('tag');
    expect((await run({ kind: 'deleteTag', name: 'v1' })).status).toBe('done');
    await ops.undo();
    expect(await test.git('cat-file', '-t', 'v1')).toBe('tag');
  });

  it('checks out a commit (detached) and comes back on undo', async () => {
    const plan = await ops.plan({ kind: 'checkout', target: 'HEAD~1', detach: true });
    expect(plan.commands[0]!.args.slice(0, 2)).toEqual(['switch', '--detach']);
    await ops.execute(plan.id);
    expect(await test.git('branch', '--show-current')).toBe('');
    await ops.undo();
    expect(await test.git('branch', '--show-current')).toBe('main');
  });

  it('validates names before anything runs', async () => {
    expect((await ops.plan({ kind: 'createBranch', name: 'bad name', at: 'HEAD' })).blocked).toBe(true);
    expect((await ops.plan({ kind: 'createBranch', name: 'feature', at: 'HEAD' })).blocked).toBe(true);
    expect((await ops.plan({ kind: 'createBranch', name: '-x', at: 'HEAD' })).blocked).toBe(true);
    const result = await run({ kind: 'createBranch', name: 'bad name', at: 'HEAD' });
    expect(result.status).toBe('refused');
  });

  it('journals the author-visible identity of commits it creates', async () => {
    // Operations run with the user's identity (here the fixture's), never a synthetic one.
    await run({ kind: 'cherryPick', commits: [await test.rev('feature')] });
    expect(await test.git('log', '-1', '--format=%cn', 'main')).toBe('Alice Archer');
    void BOB;
  });
});
