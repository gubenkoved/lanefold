import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

describe('carrying uncommitted changes through a cherry-pick or revert (real git)', () => {
  let test: TestRepo;
  let h: OpsHarness;
  /** On `side`: adds side.txt (applies cleanly on main). */
  let clean: string;
  /** On `side`: changes the line of shared.txt that main changed too (conflicts on main). */
  let clashing: string;

  beforeEach(async () => {
    test = await TestRepo.create();
    await test.commit('base', {
      files: { 'shared.txt': 'one\n', 'mine.txt': 'first\nmiddle\nlast\n' },
    });
    await test.checkoutNew('side');
    clean = await test.commit('side file', { files: { 'side.txt': 'side\n' } });
    clashing = await test.commit('side clash', { files: { 'shared.txt': 'side\n' } });
    await test.checkout('main');
    await test.commit('main clash', { files: { 'shared.txt': 'main\n' } });
    h = await openOps(test);
  });

  afterEach(() => h.dispose());

  const read = (file: string) => readFile(join(test.path, file), 'utf8');

  /** A staged edit to mine.txt and an unstaged one to another file: what is in the way. */
  async function dirty(): Promise<string> {
    await test.write('mine.txt', 'first\nmiddle\nlast, edited\n');
    await test.git('add', 'mine.txt');
    await test.write('notes.txt', 'untracked\n');
    return test.git('status', '--porcelain');
  }

  it('offers to carry what is staged, then carries it; Undo puts everything back', async () => {
    const status = await dirty();
    const head = await test.rev('HEAD');
    const blocked = await h.ops.plan({ kind: 'cherryPick', commits: [clean] });
    expect(blocked.blocked).toBe(true);
    expect(blocked.carryOver).toEqual({ files: ['mine.txt'] });
    expect(blocked.notices.find((notice) => notice.level === 'danger')?.text).toBe(
      '1 staged file is in the way: git cherry-picks only when nothing is staged. Carry your changes over, or commit or stash them first.',
    );

    const plan = await h.ops.plan({ kind: 'cherryPick', commits: [clean], carry: true });
    expect(plan.blocked).toBeFalsy();
    expect(plan.commands.map((command) => command.args)).toEqual([
      ['stash', 'push', '-m', 'lanefold: set aside for a cherry-pick'],
      ['cherry-pick', clean],
      ['stash', 'pop', '--index'],
    ]);
    expect(plan.title).toBe('Cherry-pick “side file” onto main');
    const result = await h.ops.execute(plan.id);
    expect(result, result.message).toMatchObject({
      status: 'done',
      outcome: 'Cherry-picked “side file” onto main',
    });
    expect(await test.log('HEAD')).toEqual(['side file', 'main clash', 'base']);
    expect(await test.git('status', '--porcelain')).toBe(status);
    expect(await test.git('stash', 'list')).toBe('');

    const undone = await h.ops.undo();
    expect(undone, undone.message).toMatchObject({
      status: 'done',
      outcome: 'Undid “Cherry-pick ‘side file’ onto main”',
    });
    expect(await test.rev('HEAD')).toBe(head);
    expect(await test.git('status', '--porcelain')).toBe(status);
  });

  it('carries unstaged changes to a file a revert changes, merged into the result', async () => {
    const reverted = await test.commit('first line', { files: { 'mine.txt': 'FIRST\nmiddle\nlast\n' } });
    await test.write('mine.txt', 'FIRST\nmiddle\nlast, edited\n');
    const blocked = await h.ops.plan({ kind: 'revert', commits: [reverted] });
    expect(blocked.notices.find((notice) => notice.level === 'danger')?.text).toBe(
      'Your uncommitted changes to mine.txt would be overwritten. Carry them over, or commit or stash them first.',
    );
    expect(blocked.carryOver).toEqual({ files: ['mine.txt'] });

    const plan = await h.ops.plan({ kind: 'revert', commits: [reverted], carry: true });
    // Nothing staged: they come back as they are (no --index).
    expect(plan.commands.map((command) => command.args[1])).toEqual(['push', '--no-edit', 'pop']);
    const result = await h.ops.execute(plan.id);
    expect(result, result.message).toMatchObject({ status: 'done', outcome: 'Reverted “first line”' });
    expect(await read('mine.txt')).toBe('first\nmiddle\nlast, edited\n');
    expect(await test.git('status', '--porcelain')).toBe(' M mine.txt');
  });

  it('when git stops on a conflict, the changes wait on the stash list until it is done', async () => {
    const status = await dirty();
    const head = await test.rev('HEAD');
    const plan = await h.ops.plan({ kind: 'cherryPick', commits: [clashing], carry: true });
    expect(plan.conflicts).toEqual({ predicted: true, files: ['shared.txt'] });
    const stopped = await h.ops.execute(plan.id);
    expect(stopped.status).toBe('conflicts');
    expect(stopped.message).toBe(
      'Stopped on 1 conflicted file. Your uncommitted changes wait on the stash list: they come back once it is done or aborted.',
    );
    expect(await test.git('stash', 'list')).toBe('stash@{0}: On main: lanefold: set aside for a cherry-pick');
    expect(await read('mine.txt')).toBe('first\nmiddle\nlast\n');
    // The stop names the operation that was started.
    expect((await h.ops.opState()).started).toEqual({
      kind: 'cherryPick',
      title: 'Cherry-pick “side clash” onto main',
    });

    await test.write('shared.txt', 'resolved\n');
    await test.git('add', 'shared.txt');
    const done = await h.ops.execute((await h.ops.plan({ kind: 'continue' })).id);
    expect(done, done.message).toMatchObject({
      status: 'done',
      title: 'Cherry-pick “side clash” onto main',
      outcome: 'Cherry-picked “side clash” onto main',
    });
    expect(done.message).toMatch(/Your uncommitted changes are back\.$/);
    expect(await test.git('stash', 'list')).toBe('');
    expect(await test.git('status', '--porcelain')).toBe(status);
    expect(await read('shared.txt')).toBe('resolved\n');

    // One Undo takes back the whole cherry-pick, and leaves the changes as they were.
    expect((await h.ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(head);
    expect(await test.git('status', '--porcelain')).toBe(status);
    expect(await read('shared.txt')).toBe('main\n');
  });

  it('aborting the stopped operation brings the changes back too', async () => {
    const status = await dirty();
    const head = await test.rev('HEAD');
    const stopped = await h.ops.execute(
      (await h.ops.plan({ kind: 'cherryPick', commits: [clashing], carry: true })).id,
    );
    expect(stopped.status).toBe('conflicts');
    const abort = await h.ops.plan({ kind: 'abort' });
    expect(abort.title).toBe('Abort the cherry-pick');
    const aborted = await h.ops.execute(abort.id);
    expect(aborted, aborted.message).toMatchObject({ status: 'done', outcome: 'Aborted the cherry-pick' });
    expect(aborted.message).toMatch(/Your uncommitted changes are back\.$/);
    expect(await test.rev('HEAD')).toBe(head);
    expect(await test.git('status', '--porcelain')).toBe(status);
    expect(await test.git('stash', 'list')).toBe('');
  });
});
