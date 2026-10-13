import { spawnSync } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOpState } from '../../src/core/ops/opState';
import type { OperationResult } from '../../src/shared/operations';
import { openOps, REBASE_SCRIPT, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

/*
 * A rebase step git cannot carry out because it cannot replace a file: on Windows, one another
 * program has open. Here a folder made read-only half-way through the rebase does the same
 * (root ignores permissions, so these run as a normal user only).
 */
const canLock = process.platform !== 'win32' && process.getuid?.() !== 0;

describe.skipIf(!canLock)('a rebase step git could not carry out (real git)', () => {
  let test: TestRepo;
  let harness: OpsHarness;
  const c: Record<'one' | 'two' | 'three', string> = { one: '', two: '', three: '' };

  const lock = () => chmod(join(test.path, 'dir'), 0o555);
  const unlock = () => chmod(join(test.path, 'dir'), 0o755);
  const status = () => test.git('status', '--porcelain');
  const stashes = () => test.git('stash', 'list');
  const subjects = () => test.git('log', '--format=%s');

  beforeEach(async () => {
    test = await TestRepo.create();
    harness = await openOps(test, { rebaseScript: REBASE_SCRIPT });
    c.one = await test.commit('one', { files: { 'dir/a.txt': '1\n', 'top.txt': '1\n' } });
    c.two = await test.commit('two', {
      files: { 'dir/a.txt': '2\n', 'top.txt': '2\n', 'new/x.txt': 'new\n' },
    });
    c.three = await test.commit('three', { files: { 'zz.txt': '3\n' } });
  });

  afterEach(async () => {
    await unlock().catch(() => undefined);
    await harness.dispose();
  });

  /** Rebases with a todo that locks dir/ before "two": git fails to replace dir/a.txt. */
  async function failMidway(): Promise<void> {
    const todo = join(test.path, '..', 'todo');
    await writeFile(todo, `pick ${c.one}\nexec chmod a-w dir\npick ${c.two}\npick ${c.three}\n`);
    const result = await test.runner.run({
      cwd: test.path,
      args: ['rebase', '-i', '--root'],
      env: { GIT_SEQUENCE_EDITOR: `cp "${todo}"`, GIT_EDITOR: 'true' },
      okExitCodes: [0, 1],
    });
    expect(result.exitCode).toBe(1);
  }

  it('knows the step: which commit, still to do, with what it wrote in the way', async () => {
    await failMidway();
    const state = await readOpState(harness.repo);
    expect(state).toMatchObject({
      kind: 'rebase',
      conflicts: [],
      editStop: false,
      commit: c.two,
      commitSubject: 'two',
      failedStep: { commit: c.two, subject: 'two' },
    });
    // git wrote top.txt and new/x.txt before failing on dir/a.txt.
    expect(await status()).toBe(' M top.txt\n?? new/');
  });

  it('Retry puts back what the step wrote and runs it again; while the file is held it fails, in plain words', async () => {
    await failMidway();
    const plan = await harness.ops.plan({ kind: 'continue' });
    expect(plan.title).toBe('Retry “two”');
    expect(plan.commands.map((command) => command.args.slice(0, 2).join(' '))).toEqual([
      'restore --source=HEAD',
      'rm --cached',
      'clean --force',
      'rebase --continue',
    ]);

    const stuck = await harness.ops.execute(plan.id);
    expect(stuck).toMatchObject({ status: 'failed', errorKind: 'fileInUse' });
    expect(stuck.message).toBe(
      'Git could not replace dir/a.txt (Permission denied): another program may have it open, such as an editor, a build or antivirus. Close it, then retry.',
    );
    // Still at the same step, the reason kept for the banner, and nothing saved or lost.
    const state = await harness.ops.opState();
    expect(state.failedStep).toMatchObject({ commit: c.two, reason: stuck.message });
    expect(await stashes()).toBe('');

    await unlock();
    const done = await harness.run({ kind: 'continue' });
    expect(done.status).toBe('done');
    expect(await subjects()).toBe('three\ntwo\none');
    expect(await status()).toBe('');
    expect(await stashes()).toBe('');
    expect((await readOpState(harness.repo)).kind).toBeUndefined();
  });

  it('Retry handles what the step wrote when git left it staged, too', async () => {
    await failMidway();
    // git left them staged on the first attempt in the field ("you have staged changes").
    await test.git('add', '-A', '--', 'top.txt', 'new/x.txt');
    const refused = await test.runner.run({
      cwd: test.path,
      args: ['rebase', '--continue'],
      okExitCodes: [0, 1],
    });
    expect(refused.exitCode).toBe(1);
    await unlock();
    const result = await harness.run({ kind: 'continue' });
    expect(result.status).toBe('done');
    expect(await subjects()).toBe('three\ntwo\none');
    expect(await status()).toBe('');
    expect(await stashes()).toBe('');
  });

  it('Skip really leaves the step out (git’s own skip would run it again)', async () => {
    await failMidway();
    await unlock();
    const plan = await harness.ops.plan({ kind: 'skip' });
    expect(plan.commands.map((command) => command.args.slice(0, 2).join(' '))).toEqual([
      'restore --source=HEAD',
      'rm --cached',
      'clean --force',
      'rebase --edit-todo',
      'rebase --continue',
    ]);
    const result = await harness.ops.execute(plan.id);
    expect(result.status).toBe('done');
    expect(await subjects()).toBe('three\none');
    expect(await status()).toBe('');
    expect(await readFile(join(test.path, 'top.txt'), 'utf8')).toBe('1\n');
    // What the step wrote was git's own: nothing to save.
    expect(await stashes()).toBe('');
  });

  it('Abort puts the branch back, though the step’s new file was in its way', async () => {
    await failMidway();
    await unlock();
    // git alone refuses: new/x.txt (untracked now) would be overwritten.
    const refused = await test.runner.run({
      cwd: test.path,
      args: ['rebase', '--abort'],
      okExitCodes: [0, 128],
    });
    expect(refused.exitCode).toBe(128);

    const result = await harness.run({ kind: 'abort' });
    expect(result.status).toBe('done');
    expect(await test.git('rev-parse', 'HEAD')).toBe(c.three);
    expect(await status()).toBe('');
    expect(await stashes()).toBe('');
  });

  it('Abort while the file is still held fails in plain words; once it is free, Abort works', async () => {
    await failMidway();
    const stuck = await harness.attempt({ kind: 'abort' });
    expect(stuck.status).toBe('failed');
    expect(stuck.message).toMatch(/^Git could not replace dir\/a\.txt/);
    await unlock();
    const result = await harness.run({ kind: 'abort' });
    expect(result.status).toBe('done');
    expect(await test.git('rev-parse', 'HEAD')).toBe(c.three);
    expect(await status()).toBe('');
  });

  it('never loses edits made in the step’s files: they are saved as a stash first', async () => {
    await failMidway();
    await test.write('top.txt', 'mine\n');
    await unlock();
    const plan = await harness.ops.plan({ kind: 'continue' });
    expect(plan.commands[0]!.args.slice(0, 2)).toEqual(['stash', 'push']);
    const result = await harness.ops.execute(plan.id);
    expect(result.status).toBe('done');
    expect(await subjects()).toBe('three\ntwo\none');
    expect(await stashes()).toMatch(/Lanefold: changes in the way of retrying “two”/);
    expect(await test.git('show', 'stash@{0}:top.txt')).toBe('mine');
  });

  it('saves an untracked file of your own that stands where the branch has one, then aborts', async () => {
    // A plain stop (git stopped to edit "one"), then a file of the same name as one the branch
    // has, with other content.
    const todo = join(test.path, '..', 'todo');
    await writeFile(todo, `edit ${c.one}\npick ${c.two}\npick ${c.three}\n`);
    await test.runner.run({
      cwd: test.path,
      args: ['rebase', '-i', '--root'],
      env: { GIT_SEQUENCE_EDITOR: `cp "${todo}"`, GIT_EDITOR: 'true' },
    });
    await test.write('zz.txt', 'my own notes\n');
    const result = await harness.run({ kind: 'abort' });
    expect(result.status).toBe('done');
    expect(await test.git('rev-parse', 'HEAD')).toBe(c.three);
    expect(await readFile(join(test.path, 'zz.txt'), 'utf8')).toBe('3\n');
    expect(await test.git('show', 'stash@{0}^3:zz.txt')).toBe('my own notes');
  });

  it('a history edit Lanefold runs that fails says why, and the banner keeps the reason', async () => {
    // "two" changes dir/a.txt and "four" changes it back: the edit (two after three) starts where
    // dir/ needs no change, then cannot write dir/a.txt for "two".
    const four = await test.commit('four', {
      files: { 'dir/a.txt': '1\n', 'top.txt': '1\n', 'new/x.txt': null },
    });
    await lock();
    const result = await harness.run({
      kind: 'rewrite',
      base: c.one,
      entries: [
        { sha: c.three, action: 'pick' },
        { sha: c.two, action: 'pick' },
        { sha: four, action: 'pick' },
      ],
      updateRefs: false,
    });
    expect(result).toMatchObject({ status: 'stopped', errorKind: 'fileInUse' });
    expect(result.message).toMatch(/^Could not apply [0-9a-f]{8} “two”: Git could not replace dir\/a\.txt/);
    const state = await harness.ops.opState();
    expect(state.failedStep?.reason).toMatch(/^Git could not replace dir\/a\.txt \(Permission denied\)/);

    await unlock();
    const done: OperationResult = await harness.run({ kind: 'continue' });
    expect(done.status).toBe('done');
    expect(await subjects()).toBe('four\ntwo\nthree\none');
    expect(await status()).toBe('');
  });
});

describe.skipIf(!canLock)('a cherry-pick or revert git could not carry out (real git)', () => {
  let test: TestRepo;
  let harness: OpsHarness;
  const c: Record<'one' | 'two' | 'three', string> = { one: '', two: '', three: '' };

  const lock = () => chmod(join(test.path, 'dir'), 0o555);
  const unlock = () => chmod(join(test.path, 'dir'), 0o755);
  const status = () => test.git('status', '--porcelain');
  const subjects = () => test.git('log', '--format=%s');

  beforeEach(async () => {
    test = await TestRepo.create();
    harness = await openOps(test, { rebaseScript: REBASE_SCRIPT });
    c.one = await test.commit('one', { files: { 'dir/a.txt': '1\n', 'top.txt': '1\n' } });
    await test.checkoutNew('side');
    c.two = await test.commit('two', {
      files: { 'dir/a.txt': '2\n', 'top.txt': '2\n', 'new/x.txt': 'new\n' },
    });
    c.three = await test.commit('three', { files: { 'zz.txt': '3\n' } });
    await test.checkout('main');
  });

  afterEach(async () => {
    await unlock().catch(() => undefined);
    await harness.dispose();
  });

  it('a pick that fails says why, and Retry picks it again (git’s --continue would drop it)', async () => {
    await lock();
    const stopped = await harness.run({ kind: 'cherryPick', commits: [c.two, c.three], recordOrigin: true });
    expect(stopped).toMatchObject({ status: 'stopped', errorKind: 'fileInUse' });
    expect(stopped.message).toMatch(/^Could not apply [0-9a-f]{8} “two”: Git could not replace dir\/a\.txt/);
    const state = await harness.ops.opState();
    expect(state).toMatchObject({ kind: 'cherry-pick', failedStep: { commit: c.two } });
    expect(state.failedStep?.reason).toMatch(/^Git could not replace dir\/a\.txt/);

    await unlock();
    const plan = await harness.ops.plan({ kind: 'continue' });
    expect(plan.commands.map((command) => command.args.slice(0, 2).join(' '))).toEqual([
      'restore --source=HEAD',
      'rm --cached',
      'clean --force',
      'cherry-pick --quit',
      'cherry-pick -x',
    ]);
    const done = await harness.ops.execute(plan.id);
    expect(done.status).toBe('done');
    expect(await subjects()).toBe('three\ntwo\none');
    // As the user asked: the origin of each pick recorded.
    expect(await test.git('log', '-1', '--format=%b', 'HEAD~1')).toContain(
      `cherry picked from commit ${c.two}`,
    );
    expect(await status()).toBe('');
    // One Undo takes back the whole cherry-pick.
    expect(done.entry).toBeDefined();
    await harness.ops.undo(done.entry!.id);
    expect(await test.git('rev-parse', 'HEAD')).toBe(c.one);
  });

  it('Skip leaves the failed pick out; Abort puts HEAD back and clears what it wrote', async () => {
    await lock();
    await harness.run({ kind: 'cherryPick', commits: [c.two, c.three] });
    await unlock();
    const skipped = await harness.run({ kind: 'skip' });
    expect(skipped.status).toBe('done');
    expect(await subjects()).toBe('three\none');
    expect(await status()).toBe('');

    await test.git('reset', '-q', '--hard', c.one);
    await lock();
    await harness.run({ kind: 'cherryPick', commits: [c.two, c.three] });
    await unlock();
    const aborted = await harness.run({ kind: 'abort' });
    expect(aborted.status).toBe('done');
    expect(await test.git('rev-parse', 'HEAD')).toBe(c.one);
    expect(await status()).toBe('');
  });

  it('a revert that fails is retried as a revert', async () => {
    // On side, revert "two" and "three" back to "one" (newest first).
    await test.checkout('side');
    await lock();
    const stopped = await harness.run({ kind: 'revert', commits: [c.three, c.two] });
    expect(stopped.status === 'stopped' || stopped.status === 'failed').toBe(true);
    await unlock();
    const state = await harness.ops.opState();
    if (state.kind) {
      expect(state).toMatchObject({ kind: 'revert', failedStep: { commit: c.two } });
      const done = await harness.run({ kind: 'continue' });
      expect(done.status).toBe('done');
    }
    expect(await subjects()).toMatch(/^Revert "two"\nRevert "three"\nthree\ntwo\none$/);
    expect(await test.git('show', 'HEAD:dir/a.txt')).toBe('1');
    expect(await status()).toBe('');
  });

  it('a sequence whose stopped pick was committed by hand just goes on', async () => {
    // Conflict on "two", resolved and committed by hand: --continue is right then.
    await test.write('top.txt', 'theirs\n');
    await test.git('commit', '-qam', 'local');
    const stopped = await harness.run({ kind: 'cherryPick', commits: [c.two, c.three] });
    expect(stopped.status).toBe('conflicts');
    await test.write('top.txt', 'merged\n');
    await test.git('add', 'top.txt');
    await test.git('commit', '-q', '--no-edit');
    const state = await harness.ops.opState();
    expect(state).toMatchObject({ kind: 'cherry-pick', conflicts: [] });
    expect(state.failedStep).toBeUndefined();
    const done = await harness.run({ kind: 'continue' });
    expect(done.status).toBe('done');
    expect(await subjects()).toBe('three\ntwo\nlocal\none');
  });
});

describe('the sequence editor’s drop mode', () => {
  const script = resolve('src/core/rebase/sequence-editor.cjs');
  const drop = (todo: string, commit: string) =>
    spawnSync(process.execPath, [script, todo], {
      env: { ...process.env, LANEFOLD_TODO_DROP: commit },
      encoding: 'utf8',
    });

  it('drops the failed step from the top of the todo, and nothing else', async () => {
    const test = await TestRepo.create();
    try {
      const todo = join(test.path, 'todo');
      await writeFile(todo, 'pick 1a2b3c4 two\npick 5d6e7f8 three\n\n# Rebase onto…\n');
      expect(drop(todo, '5d6e7f8000000000000000000000000000000000').status).toBe(1);
      expect(await readFile(todo, 'utf8')).toBe('pick 1a2b3c4 two\npick 5d6e7f8 three\n\n# Rebase onto…\n');
      const result = drop(todo, '1a2b3c4000000000000000000000000000000000');
      expect(result.status).toBe(0);
      expect(await readFile(todo, 'utf8')).toBe('pick 5d6e7f8 three\n\n# Rebase onto…\n');
    } finally {
      await test.dispose();
    }
  });
});
