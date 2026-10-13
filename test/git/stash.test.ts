import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import type { RepoData } from '../../src/core/repo/repoData';
import type { Operation } from '../../src/shared/operations';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

describe('stash (real git)', () => {
  let test: TestRepo;
  let data: RepoData;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];

  beforeEach(async () => {
    test = await TestRepo.create();
    await test.commit('base', { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    ({ data, ops, run, dispose } = await openOps(test));
  });

  afterEach(() => dispose());

  const read = (file: string) => readFile(join(test.path, file), 'utf8');
  const status = () => test.git('status', '--porcelain=v1', '--untracked-files=all');
  const stashes = () => test.git('stash', 'list', '--format=%gs');

  /** Staged a.txt, unstaged b.txt, untracked new.txt. */
  async function makeChanges(): Promise<void> {
    await test.write('a.txt', 'a staged\n');
    await test.git('add', 'a.txt');
    await test.write('b.txt', 'b edited\n');
    await test.write('new.txt', 'new\n');
  }

  it('stashes everything with a message; Undo restores the exact files and removes the stash', async () => {
    await makeChanges();
    const plan = await ops.plan({ kind: 'stashPush', message: 'half-done\nwork', includeUntracked: true });
    expect(plan.title).toBe('Stash “half-done work”');
    expect(plan.commands[0]!.args).toEqual(['stash', 'push', '-m', 'half-done work', '--include-untracked']);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await status()).toBe('');
    expect(await stashes()).toBe('On main: half-done work');

    const list = await data.stashList();
    expect(list).toMatchObject([
      { index: 0, message: 'half-done work', generated: false, branch: 'main', untracked: true },
    ]);
    const details = await data.stashDetails(list[0]!.sha);
    expect(details.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
    expect(details.staged.map((f) => f.path)).toEqual(['a.txt']);
    expect(details.untracked.map((f) => f.path)).toEqual(['new.txt']);

    expect((await ops.undo()).status).toBe('done');
    expect(await status()).toBe('M  a.txt\n M b.txt\n?? new.txt');
    expect(await read('b.txt')).toBe('b edited\n');
    expect(await stashes()).toBe('');
    expect(ops.undoInfo.redo).toBeUndefined();
  });

  it('keeps staged changes in place with --keep-index, and still undoes exactly', async () => {
    await makeChanges();
    await run({ kind: 'stashPush', keepIndex: true });
    expect(await status()).toBe('M  a.txt\n?? new.txt');
    expect(await stashes()).toMatch(/^WIP on main: [0-9a-f]+ base$/);
    expect((await ops.undo()).status).toBe('done');
    expect(await status()).toBe('M  a.txt\n M b.txt\n?? new.txt');
    expect(await stashes()).toBe('');
  });

  it('refuses to undo a stash when files changed since, and changes nothing', async () => {
    await makeChanges();
    await run({ kind: 'stashPush' });
    await test.write('a.txt', 'edited after stashing\n');
    expect(await ops.undo()).toMatchObject({ status: 'refused', errorKind: 'dirtyWorkTree' });
    expect(await read('a.txt')).toBe('edited after stashing\n');
    expect(await stashes()).not.toBe('');
  });

  it('applies a stash onto a clean tree; Undo removes what it brought back, files and all', async () => {
    await makeChanges();
    await run({ kind: 'stashPush', includeUntracked: true });
    const [stash] = await data.stashList();
    const result = await run({ kind: 'stashApply', stash: stash!.sha, index: true });
    expect(result.status).toBe('done');
    expect(await status()).toBe('M  a.txt\n M b.txt\n?? new.txt');
    expect(await stashes()).not.toBe('');

    expect((await ops.undo()).status).toBe('done');
    expect(await status()).toBe('');
    expect(existsSync(join(test.path, 'new.txt'))).toBe(false);
    expect((await data.stashList())[0]!.sha).toBe(stash!.sha);
  });

  it('pops a stash; Undo puts the files back as they were and the stash back on the list', async () => {
    await makeChanges();
    await run({ kind: 'stashPush', message: 'keep me', includeUntracked: true });
    const [stash] = await data.stashList();
    await test.write('other.txt', 'unrelated\n');
    const plan = await ops.plan({ kind: 'stashApply', stash: stash!.sha, pop: true });
    expect(plan.title).toBe('Pop stash@{0} “keep me”');
    expect(plan.commands[0]!.args).toEqual(['stash', 'pop', 'stash@{0}']);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await stashes()).toBe('');
    // Without --index, staged changes come back unstaged.
    expect(await status()).toBe(' M a.txt\n M b.txt\n?? new.txt\n?? other.txt');

    expect((await ops.undo()).status).toBe('done');
    expect(await status()).toBe('?? other.txt');
    expect(await stashes()).toBe('On main: keep me');
    expect((await data.stashList())[0]!.sha).toBe(stash!.sha);
  });

  it('a conflicting pop keeps the stash, reports the conflicts, and Undo cleans up', async () => {
    await test.write('a.txt', 'stashed version\n');
    await run({ kind: 'stashPush' });
    await test.commit('change a', { files: { 'a.txt': 'committed version\n' } });
    const [stash] = await data.stashList();
    const plan = await ops.plan({ kind: 'stashApply', stash: stash!.sha, pop: true });
    expect(plan.conflicts).toEqual({ predicted: true, files: ['a.txt'] });
    const result = await ops.execute(plan.id);
    expect(result).toMatchObject({ status: 'conflicts', conflicts: ['a.txt'] });
    expect(await stashes()).not.toBe('');
    expect(await status()).toBe('UU a.txt');

    expect((await ops.undo()).status).toBe('done');
    expect(await status()).toBe('');
    expect(await read('a.txt')).toBe('committed version\n');
    expect((await data.stashList()).map((s) => s.sha)).toEqual([stash!.sha]);
  });

  it('drops a stash after review; Undo stores it again with its message', async () => {
    await test.write('a.txt', 'first\n');
    await run({ kind: 'stashPush', message: 'first' });
    await test.write('b.txt', 'second\n');
    await run({ kind: 'stashPush', message: 'second' });
    const list = await data.stashList();
    const plan = await ops.plan({ kind: 'stashDrop', stash: list[1]!.sha });
    expect(plan.destructive).toBe(true);
    expect(plan.commands[0]!.args).toEqual(['stash', 'drop', 'stash@{1}']);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await stashes()).toBe('On main: second');

    expect((await ops.undo()).status).toBe('done');
    expect((await stashes()).split('\n').sort()).toEqual(['On main: first', 'On main: second']);
    expect((await data.stashList()).some((s) => s.sha === list[1]!.sha)).toBe(true);
  });

  it('refuses a stash operation when the stash list moved since planning', async () => {
    await test.write('a.txt', 'first\n');
    await run({ kind: 'stashPush', message: 'first' });
    const [first] = await data.stashList();
    const plan = await ops.plan({ kind: 'stashDrop', stash: first!.sha });
    await test.write('b.txt', 'second\n');
    await test.git('stash', 'push', '-q', '-m', 'made elsewhere');
    expect(await ops.execute(plan.id)).toMatchObject({ status: 'refused', errorKind: 'stale' });
    expect(await stashes()).toBe('On main: made elsewhere\nOn main: first');
  });

  it('blocks what cannot work, before anything runs', async () => {
    const blocked = async (operation: Operation) => {
      const plan = await ops.plan(operation);
      expect(plan.blocked).toBe(true);
      return plan.notices.find((n) => n.level === 'danger')!.text;
    };
    expect(await blocked({ kind: 'stashPush' })).toMatch(/no changes to stash/);
    await test.write('new.txt', 'new\n');
    expect(await blocked({ kind: 'stashPush' })).toMatch(/include untracked/);
    await test.write('a.txt', 'staged\n');
    await test.git('add', 'a.txt');
    expect(await blocked({ kind: 'stashPush', stagedOnly: true, includeUntracked: true })).toMatch(
      /cannot be combined/,
    );
    expect(await blocked({ kind: 'stashApply', stash: 'f'.repeat(40) })).toMatch(
      /no longer on the stash list/,
    );
  });

  it('stashes only the staged changes', async () => {
    await makeChanges();
    await run({ kind: 'stashPush', stagedOnly: true, message: 'just a' });
    expect(await status()).toBe(' M b.txt\n?? new.txt');
    const [stash] = await data.stashList();
    expect((await data.stashDetails(stash!.sha)).files.map((f) => f.path)).toEqual(['a.txt']);
    expect((await ops.undo()).status).toBe('done');
    expect(await status()).toBe('M  a.txt\n M b.txt\n?? new.txt');
  });
});
