import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import type { Operation } from '../../src/shared/operations';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

describe('per-file actions: restore a version, apply or revert one commit’s change (real git)', () => {
  let test: TestRepo;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];
  let first: string;
  let second: string;

  beforeEach(async () => {
    test = await TestRepo.create();
    first = await test.commit('first', { files: { 'a.txt': 'a1\n', 'b.txt': 'b1\n' } });
    second = await test.commit('second', { files: { 'a.txt': 'a1\na2\n', 'b.txt': 'b1\nb2\n' } });
    await test.commit('third', { files: { 'a.txt': 'a1\na2\na3\n' } });
    ({ ops, run, dispose } = await openOps(test));
  });

  afterEach(() => dispose());

  const read = (file: string) => readFile(join(test.path, file), 'utf8');
  const status = () => test.git('status', '--porcelain=v1', '--untracked-files=all');

  it('restores a file as it was in a commit; Undo puts the current version back', async () => {
    const plan = await ops.plan({ kind: 'restoreFiles', source: first, paths: ['a.txt'] });
    expect(plan.commands[0]!.args).toEqual(['restore', `--source=${first}`, '--worktree', '--', 'a.txt']);
    expect(plan.destructive).toBe(false);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await read('a.txt')).toBe('a1\n');
    expect(await status()).toBe(' M a.txt');

    expect((await ops.undo()).status).toBe('done');
    expect(await read('a.txt')).toBe('a1\na2\na3\n');
    expect(await status()).toBe('');
  });

  it('restoring over uncommitted edits is reviewed, and Undo brings the edits back', async () => {
    await test.write('a.txt', 'my edits\n');
    const plan = await ops.plan({ kind: 'restoreFiles', source: second, paths: ['a.txt'] });
    expect(plan.destructive).toBe(true);
    expect(plan.notices.some((n) => /Undo brings them back/.test(n.text))).toBe(true);
    await ops.execute(plan.id);
    expect(await read('a.txt')).toBe('a1\na2\n');
    expect((await ops.undo()).status).toBe('done');
    expect(await read('a.txt')).toBe('my edits\n');
  });

  it('brings back a deleted file, and Undo deletes it again', async () => {
    await test.git('rm', '-q', '--cached', 'b.txt');
    await test.remove('b.txt');
    await run({ kind: 'restoreFiles', source: second, paths: ['b.txt'] });
    expect(await read('b.txt')).toBe('b1\nb2\n');
    expect((await ops.undo()).status).toBe('done');
    expect(existsSync(join(test.path, 'b.txt'))).toBe(false);
  });

  it('refuses to undo a restore once the file was edited again', async () => {
    await run({ kind: 'restoreFiles', source: first, paths: ['a.txt'] });
    await test.write('a.txt', 'edited after\n');
    expect(await ops.undo()).toMatchObject({ status: 'refused', errorKind: 'dirtyWorkTree' });
    expect(await read('a.txt')).toBe('edited after\n');
  });

  it('reverts one commit’s change to one file, leaving its other files alone', async () => {
    const plan = await ops.plan({
      kind: 'applyFileChanges',
      commit: second,
      paths: ['b.txt'],
      reverse: true,
    });
    expect(plan.commands.map((c) => [c.args[0], c.pipe ?? false])).toEqual([
      ['diff', false],
      ['apply', true],
    ]);
    expect(plan.commands[1]!.args).toEqual(['apply', '--3way', '--reverse']);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await read('b.txt')).toBe('b1\n');
    expect(await read('a.txt')).toBe('a1\na2\na3\n');
    expect(await status()).toBe('M  b.txt');

    expect((await ops.undo()).status).toBe('done');
    expect(await read('b.txt')).toBe('b1\nb2\n');
    expect(await status()).toBe('');
  });

  it('applies a change from another branch to the working tree', async () => {
    await test.checkoutNew('side', first);
    const side = await test.commit('side work', { files: { 'b.txt': 'b0\nb1\n' } });
    await test.checkout('main');
    await run({ kind: 'applyFileChanges', commit: side, paths: ['b.txt'] });
    expect(await read('b.txt')).toBe('b0\nb1\nb2\n');
    expect(await test.log('HEAD')).toEqual(['third', 'second', 'first']);
  });

  it('a change that no longer applies cleanly leaves conflict markers, and Undo cleans up', async () => {
    await test.commit('rewrite a', { files: { 'a.txt': 'something else entirely\n' } });
    const result = await run({ kind: 'applyFileChanges', commit: second, paths: ['a.txt'], reverse: true });
    expect(result).toMatchObject({ status: 'conflicts', conflicts: ['a.txt'] });
    expect(await read('a.txt')).toContain('<<<<<<<');
    expect((await ops.undo()).status).toBe('done');
    expect(await read('a.txt')).toBe('something else entirely\n');
    expect(await status()).toBe('');
  });

  it('blocks what cannot work', async () => {
    const blocked = async (operation: Operation) => {
      const plan = await ops.plan(operation);
      expect(plan.blocked).toBe(true);
      return plan.notices.find((n) => n.level === 'danger')!.text;
    };
    expect(
      await blocked({ kind: 'applyFileChanges', commit: await test.rev('HEAD'), paths: ['b.txt'] }),
    ).toMatch(/does not change b\.txt/);
    await test.write('a.txt', 'dirty\n');
    expect(
      await blocked({ kind: 'applyFileChanges', commit: second, paths: ['a.txt'], reverse: true }),
    ).toMatch(/unstaged changes/);
    expect(await blocked({ kind: 'restoreFiles', source: first, paths: ['nope.txt'] })).toMatch(
      /does not exist/,
    );
  });
});
