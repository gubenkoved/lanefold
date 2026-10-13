import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOpState } from '../../src/core/ops/opState';
import type { Operation } from '../../src/shared/operations';
import { openOps, REBASE_SCRIPT, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

/*
 * Operations git gives up on half-way because it cannot replace a file: on Windows, one another
 * program has open. Here a read-only folder does the same (root ignores permissions, so these run
 * as a normal user only). Git leaves what it wrote before failing; Lanefold puts it back, so the
 * operation simply runs again once the file is free, and changes nothing meanwhile.
 */
const canLock = process.platform !== 'win32' && process.getuid?.() !== 0;

const HALF_DONE =
  /^Git could not (?:replace|write) dir\/a\.txt \(Permission denied\): another program may have it open, such as an editor, a build or antivirus\. Close it, then retry\. What git had already changed is back as before\.$/;

describe.skipIf(!canLock)('an operation git gave up on half-way (real git)', () => {
  let test: TestRepo;
  let harness: OpsHarness;
  const c: Record<'one' | 'two', string> = { one: '', two: '' };

  const lock = () => chmod(join(test.path, 'dir'), 0o555);
  const unlock = () => chmod(join(test.path, 'dir'), 0o755);
  const status = () => test.git('status', '--porcelain');
  const stashes = async () => (await test.git('stash', 'list')).split('\n').filter(Boolean).length;
  const content = (file: string) => readFile(join(test.path, file), 'utf8');

  /** main: “one”; other: “two”, which changes dir/a.txt and top.txt and adds new/x.txt. */
  beforeEach(async () => {
    test = await TestRepo.create();
    harness = await openOps(test, { rebaseScript: REBASE_SCRIPT });
    c.one = await test.commit('one', { files: { 'dir/a.txt': '1\n', 'top.txt': '1\n', 'keep.txt': 'k\n' } });
    await test.checkoutNew('other');
    c.two = await test.commit('two', {
      files: { 'dir/a.txt': '2\n', 'top.txt': '2\n', 'new/x.txt': 'new\n' },
    });
    await test.checkout('main');
  });

  afterEach(async () => {
    await unlock().catch(() => undefined);
    await harness.dispose();
  });

  /** main gets a commit of its own: merges are real merges, picks land on something else. */
  const diverge = () => test.commit('m', { files: { 'zz.txt': 'm\n' } });
  /** other's upstream is origin/other (the repository itself as origin). */
  const tracking = async () => {
    await test.git('remote', 'add', 'origin', test.path);
    await test.git('fetch', '-q', 'origin');
    await test.git('branch', '--set-upstream-to=origin/other', 'main');
  };

  interface Case {
    readonly name: string;
    /** Sets the repository up; returns the operation. */
    readonly prepare: () => Promise<Operation>;
    /** What running it again, once the file is free, comes to. */
    readonly then: () => Promise<void>;
  }

  const cases: Case[] = [
    {
      name: 'a fast-forward merge',
      prepare: async () => ({ kind: 'merge', source: 'other', strategy: 'auto' }),
      then: async () => expect(await test.log('main')).toEqual(['two', 'one']),
    },
    {
      name: 'a merge',
      prepare: async () => {
        await diverge();
        return { kind: 'merge', source: 'other', strategy: 'no-ff' };
      },
      then: async () => expect(await test.git('rev-parse', 'HEAD^2')).toBe(c.two),
    },
    {
      name: 'a squash merge',
      prepare: async () => {
        await diverge();
        return { kind: 'merge', source: 'other', strategy: 'squash' };
      },
      then: async () => expect(await test.git('show', 'HEAD:dir/a.txt')).toBe('2'),
    },
    {
      name: 'a pull',
      prepare: async () => {
        await tracking();
        return { kind: 'pull', mode: 'ff-only' };
      },
      then: async () => expect(await test.log('main')).toEqual(['two', 'one']),
    },
    {
      name: 'a pull that merges',
      prepare: async () => {
        await tracking();
        await diverge();
        return { kind: 'pull', mode: 'merge' };
      },
      then: async () => expect(await test.git('rev-parse', 'HEAD^2')).toBe(c.two),
    },
    {
      name: 'a reset that keeps changes',
      prepare: async () => ({ kind: 'reset', to: 'other', mode: 'keep' }),
      then: async () => expect(await test.rev('HEAD')).toBe(c.two),
    },
    {
      name: 'a cherry-pick',
      prepare: async () => {
        await diverge();
        return { kind: 'cherryPick', commits: [c.two] };
      },
      then: async () => expect(await test.log('main')).toEqual(['two', 'm', 'one']),
    },
    {
      name: 'a revert',
      prepare: async () => {
        await test.checkout('other');
        return { kind: 'revert', commits: [c.two] };
      },
      then: async () => expect(await test.git('show', 'HEAD:dir/a.txt')).toBe('1'),
    },
    {
      name: 'a rebase that cannot start',
      prepare: async () => {
        await diverge();
        await test.checkout('other');
        return { kind: 'rebase', onto: 'main' };
      },
      then: async () => expect(await test.log('other')).toEqual(['two', 'm', 'one']),
    },
    {
      name: 'a history edit that cannot start',
      prepare: async () => {
        await test.checkout('other');
        const three = await test.commit('three', { files: { 'q.txt': 'q\n' } });
        return {
          kind: 'rewrite',
          base: c.one,
          entries: [
            { sha: three, action: 'pick' },
            { sha: c.two, action: 'pick' },
          ],
        };
      },
      then: async () => expect(await test.log('other')).toEqual(['two', 'three', 'one']),
    },
    {
      name: 'applying a stash',
      prepare: async () => {
        await test.write('dir/a.txt', 'stashed\n');
        await test.write('top.txt', 'stashed\n');
        await test.git('stash', 'push', '-q');
        return { kind: 'stashApply', stash: await test.rev('stash@{0}') };
      },
      then: async () => {
        expect(await content('dir/a.txt')).toBe('stashed\n');
        expect(await stashes()).toBe(1);
      },
    },
    {
      name: 'popping a stash',
      prepare: async () => {
        await test.write('dir/a.txt', 'stashed\n');
        await test.write('top.txt', 'stashed\n');
        await test.git('stash', 'push', '-q');
        return { kind: 'stashApply', stash: await test.rev('stash@{0}'), pop: true };
      },
      then: async () => {
        expect(await content('dir/a.txt')).toBe('stashed\n');
        expect(await stashes()).toBe(0);
      },
    },
    {
      name: 'applying a commit’s changes to files',
      prepare: async () => ({ kind: 'applyFileChanges', commit: c.two, paths: ['top.txt', 'dir/a.txt'] }),
      then: async () => expect(await content('dir/a.txt')).toBe('2\n'),
    },
    {
      name: 'restoring files from a commit',
      prepare: async () => ({ kind: 'restoreFiles', source: 'other', paths: ['top.txt', 'dir/a.txt'] }),
      then: async () => expect(await content('dir/a.txt')).toBe('2\n'),
    },
  ];

  it.each(cases)(
    '$name: what git wrote goes back, nothing else is touched, and it runs again once the file is free',
    async ({ prepare, then }) => {
      const operation = await prepare();
      // Someone's work the operation does not touch.
      await test.write('keep.txt', 'mine\n');
      await test.write('notes.txt', 'my notes\n');
      const head = await test.rev('HEAD');
      const before = await status();
      const stashed = await stashes();

      await lock();
      const failed = await harness.attempt(operation);
      expect(failed).toMatchObject({ status: 'failed', errorKind: 'fileInUse', files: ['dir/a.txt'] });
      expect(failed.message).toMatch(HALF_DONE);
      // Nothing changed: nothing to undo.
      expect(failed.entry).toBeUndefined();
      expect((await readOpState(harness.repo)).kind).toBeUndefined();
      expect(await test.rev('HEAD')).toBe(head);
      expect(await status()).toBe(before);
      expect(await stashes()).toBe(stashed);
      expect(await content('keep.txt')).toBe('mine\n');
      expect(await content('notes.txt')).toBe('my notes\n');

      await unlock();
      const done = await harness.run(operation);
      expect(done.status, done.message).toBe('done');
      await then();
      expect(await content('keep.txt')).toBe('mine\n');
      expect(await content('notes.txt')).toBe('my notes\n');
    },
  );

  it('a hard reset puts back the changes it was to throw away (Retry throws them away)', async () => {
    await test.write('top.txt', 'mine\n');
    await test.write('u.txt', 'untracked\n');
    await lock();
    const failed = await harness.attempt({ kind: 'reset', to: 'other', mode: 'hard' });
    expect(failed).toMatchObject({ status: 'failed', errorKind: 'fileInUse' });
    expect(failed.message).toMatch(HALF_DONE);
    expect(failed.entry).toBeUndefined();
    expect(await test.rev('HEAD')).toBe(c.one);
    expect(await status()).toBe(' M top.txt\n?? u.txt');
    expect(await content('top.txt')).toBe('mine\n');

    await unlock();
    const done = await harness.run({ kind: 'reset', to: 'other', mode: 'hard' });
    expect(done.status).toBe('done');
    expect(await test.rev('HEAD')).toBe(c.two);
    expect(await status()).toBe('?? u.txt');
  });

  it('a discard brings the changes back; once the file is free it discards them all', async () => {
    await test.write('dir/a.txt', 'edited\n');
    await test.write('top.txt', 'edited\n');
    await lock();
    const failed = await harness.attempt({ kind: 'discard', paths: ['top.txt', 'dir/a.txt'] });
    expect(failed).toMatchObject({ status: 'failed', errorKind: 'fileInUse' });
    expect(failed.message).toMatch(HALF_DONE);
    expect(failed.entry).toBeUndefined();
    expect(await content('top.txt')).toBe('edited\n');
    expect(await content('dir/a.txt')).toBe('edited\n');

    await unlock();
    const done = await harness.run({ kind: 'discard', paths: ['top.txt', 'dir/a.txt'] });
    // Files changed, refs did not: the headline says it all.
    expect(done).toMatchObject({ status: 'done', message: '' });
    expect(await status()).toBe('');
  });

  it('a stash that git cannot finish leaves the changes where they were, and no stash', async () => {
    await test.write('dir/a.txt', 'mine\n');
    await test.write('top.txt', 'mine\n');
    await test.write('u.txt', 'untracked\n');
    await lock();
    const failed = await harness.attempt({ kind: 'stashPush', includeUntracked: true });
    expect(failed).toMatchObject({ status: 'failed', errorKind: 'fileInUse' });
    expect(failed.message).toMatch(HALF_DONE);
    expect(failed.entry).toBeUndefined();
    expect(await stashes()).toBe(0);
    expect(await status()).toBe(' M dir/a.txt\n M top.txt\n?? u.txt');
    expect(await content('top.txt')).toBe('mine\n');
    expect(await content('u.txt')).toBe('untracked\n');

    await unlock();
    const done = await harness.run({ kind: 'stashPush', includeUntracked: true });
    expect(done.status).toBe('done');
    expect(await stashes()).toBe(1);
    expect(await status()).toBe('');
  });

  it('a cherry-pick that carries changes brings them back onto the files as they were', async () => {
    await diverge();
    await test.write('top.txt', 'mine\n');
    await lock();
    const failed = await harness.attempt({ kind: 'cherryPick', commits: [c.two], carry: true });
    expect(failed).toMatchObject({ status: 'failed', errorKind: 'fileInUse' });
    expect(failed.message).toMatch(HALF_DONE);
    expect(await status()).toBe(' M top.txt');
    expect(await content('top.txt')).toBe('mine\n');
    expect(await stashes()).toBe(0);
  });

  describe('an Undo git could not finish', () => {
    it('puts back what git wrote; once the file is free, Undo works', async () => {
      const merged = await harness.run({ kind: 'merge', source: 'other', strategy: 'auto' });
      expect(merged.status).toBe('done');
      await lock();
      const failed = await harness.ops.undo(merged.entry!.id);
      expect(failed).toMatchObject({ status: 'failed', errorKind: 'fileInUse', files: ['dir/a.txt'] });
      expect(await test.rev('HEAD')).toBe(c.two);
      expect(await status()).toBe('');

      await unlock();
      const undone = await harness.ops.undo(merged.entry!.id);
      expect(undone.status).toBe('done');
      expect(await test.rev('HEAD')).toBe(c.one);
      expect(await status()).toBe('');
    });

    it('switching back, says which file still has its old content', async () => {
      const switched = await harness.run({ kind: 'checkout', target: 'other' });
      await lock();
      const undone = await harness.ops.undo(switched.entry!.id);
      expect(undone).toMatchObject({ status: 'done', errorKind: 'fileInUse', files: ['dir/a.txt'] });
      expect(undone.message).toContain('dir/a.txt still has the old content: git could not update it');
      expect(await test.git('branch', '--show-current')).toBe('main');
      expect(await status()).toBe(' M dir/a.txt');
    });
  });

  describe('a switch git could not finish', () => {
    it('says which file still has its old content, and Undo goes back while it is still held', async () => {
      await lock();
      const result = await harness.attempt({ kind: 'checkout', target: 'other' });
      expect(result).toMatchObject({
        status: 'done',
        errorKind: 'fileInUse',
        files: ['dir/a.txt'],
        message:
          'dir/a.txt still has the old content: git could not update it (Permission denied). Close the program that has it open, then update it.',
      });
      expect(await test.git('branch', '--show-current')).toBe('other');
      expect(await status()).toBe(' M dir/a.txt');

      // Back to main: the file has main's content already, so git need not touch it.
      const undone = await harness.ops.undo(result.entry!.id);
      expect(undone.status).toBe('done');
      expect(await test.git('branch', '--show-current')).toBe('main');
      expect(await status()).toBe('');
    });

    it('once the file is free, discarding its old content finishes the switch', async () => {
      await lock();
      const result = await harness.attempt({ kind: 'checkout', target: 'other' });
      expect(result.files).toEqual(['dir/a.txt']);
      await unlock();
      const done = await harness.run({ kind: 'discard', paths: ['dir/a.txt'] });
      expect(done.status).toBe('done');
      expect(await status()).toBe('');
      expect(await content('dir/a.txt')).toBe('2\n');
    });

    it('a file held only for a moment is updated after it, with nothing to report', async () => {
      await lock();
      const released = new Promise<void>((resolve) =>
        setTimeout(() => void unlock().then(() => resolve()), 120),
      );
      const result = await harness.attempt({ kind: 'checkout', target: 'other' });
      await released;
      expect(result.status).toBe('done');
      expect(result.errorKind).toBeUndefined();
      expect(await status()).toBe('');
      expect(await content('dir/a.txt')).toBe('2\n');
    });
  });
});
