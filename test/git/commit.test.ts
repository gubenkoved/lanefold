import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

describe('commit and discard (real git)', () => {
  let test: TestRepo;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];

  beforeEach(async () => {
    test = await TestRepo.create();
    await test.commit('base', { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    ({ ops, run, dispose } = await openOps(test));
  });

  afterEach(() => dispose());

  const read = (file: string) => readFile(join(test.path, file), 'utf8');
  const status = () => test.git('status', '--porcelain=v1', '--untracked-files=all');

  it('commits what is staged; Undo brings the changes back staged, Redo recommits', async () => {
    await test.write('a.txt', 'a changed\n');
    await test.write('b.txt', 'b changed\n');
    await test.git('add', 'a.txt');
    const plan = await ops.plan({ kind: 'commit', message: 'Change a\n\nOnly a.' });
    expect(plan.commands[0]!.args).toEqual(['commit', '-m', 'Change a\n\nOnly a.']);
    expect(plan.notices.some((n) => /stay out of the commit/.test(n.text))).toBe(true);
    expect((await ops.execute(plan.id)).status).toBe('done');
    const committed = await test.rev('HEAD');
    expect(await test.git('log', '-1', '--format=%B')).toBe('Change a\n\nOnly a.');
    expect(await status()).toBe(' M b.txt');

    expect((await ops.undo()).status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['base']);
    expect(await status()).toBe('M  a.txt\n M b.txt');

    expect((await ops.redo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(committed);
    expect(await status()).toBe(' M b.txt');
  });

  it('refuses to commit nothing or without a message', async () => {
    expect((await ops.plan({ kind: 'commit', message: 'Empty' })).blocked).toBe(true);
    await test.write('a.txt', 'x\n');
    await test.git('add', 'a.txt');
    expect((await ops.plan({ kind: 'commit', message: '  \n ' })).blocked).toBe(true);
  });

  it('amends the last commit (message only, or with staged changes) and undoes it', async () => {
    const original = await test.rev('HEAD');
    const reword = await ops.plan({ kind: 'commit', message: 'Base, better described', amend: true });
    expect(reword.destructive).toBe(true);
    expect(reword.commands[0]!.args).toEqual(['commit', '--amend', '-m', 'Base, better described']);
    expect((await ops.execute(reword.id)).status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['Base, better described']);

    await test.write('b.txt', 'b amended\n');
    await test.git('add', 'b.txt');
    expect((await run({ kind: 'commit', message: '', amend: true })).status).toBe('done');
    expect(await test.git('show', 'HEAD:b.txt')).toBe('b amended');
    expect(await test.log('HEAD')).toEqual(['Base, better described']);

    expect((await ops.undo()).status).toBe('done');
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(original);
  });

  it('discards some files with a snapshot; Undo restores just those, even with other edits around', async () => {
    await test.write('a.txt', 'a edited\n');
    await test.write('b.txt', 'b edited\n');
    await test.write('notes/new.txt', 'brand new\n');
    const plan = await ops.plan({ kind: 'discard', paths: ['a.txt', 'notes/new.txt'] });
    expect(plan.destructive).toBe(true);
    expect(plan.commands.map((c) => c.args)).toEqual([
      ['restore', '--worktree', '--', 'a.txt'],
      ['clean', '-f', '-q', '--', 'notes/new.txt'],
    ]);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await read('a.txt')).toBe('a\n');
    expect(existsSync(join(test.path, 'notes/new.txt'))).toBe(false);
    expect(await read('b.txt')).toBe('b edited\n');

    // b.txt is still modified: the discard can be undone anyway.
    expect((await ops.undo()).status).toBe('done');
    expect(await read('a.txt')).toBe('a edited\n');
    expect(await read('notes/new.txt')).toBe('brand new\n');
    expect(await read('b.txt')).toBe('b edited\n');
    expect(ops.undoInfo.redo).toBeUndefined();
  });

  it('discards exactly the named file, even when its name looks like a pattern', async () => {
    await test.commit('styles', { files: { '*.css': 'star\n', 'site.css': 'site\n' } });
    await test.write('*.css', 'star edited\n');
    await test.write('site.css', 'site edited\n');
    await test.write('[draft].md', 'new\n');
    await test.write('d.md', 'also new\n');
    const plan = await ops.plan({ kind: 'discard', paths: ['*.css', '[draft].md'] });
    expect(plan.commands.map((c) => c.args)).toEqual([
      ['restore', '--worktree', '--', ':(literal)*.css'],
      ['clean', '-f', '-q', '--', ':(literal)[draft].md'],
    ]);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await read('*.css')).toBe('star\n');
    expect(await read('site.css')).toBe('site edited\n');
    expect(existsSync(join(test.path, '[draft].md'))).toBe(false);
    expect(await read('d.md')).toBe('also new\n');

    expect((await ops.undo()).status).toBe('done');
    expect(await read('*.css')).toBe('star edited\n');
    expect(await read('[draft].md')).toBe('new\n');
  });

  it('an Undo aimed at one operation is refused once another was done after it', async () => {
    await test.write('a.txt', 'a changed\n');
    await test.git('add', 'a.txt');
    const first = await run({ kind: 'commit', message: 'First' });
    await test.write('b.txt', 'b changed\n');
    await test.git('add', 'b.txt');
    const second = await run({ kind: 'commit', message: 'Second' });
    expect(await ops.undo(first.entry!.id)).toMatchObject({ status: 'refused', errorKind: 'stale' });
    expect(await test.log('HEAD')).toEqual(['Second', 'First', 'base']);
    expect((await ops.undo(second.entry!.id)).status).toBe('done');
    expect((await ops.undo(first.entry!.id)).status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['base']);
  });

  it('refuses to undo a discard over a file edited again since', async () => {
    await test.write('a.txt', 'a edited\n');
    await run({ kind: 'discard', paths: ['a.txt'] });
    await test.write('a.txt', 'edited again\n');
    expect(await ops.undo()).toMatchObject({ status: 'refused', errorKind: 'dirtyWorkTree' });
    expect(await read('a.txt')).toBe('edited again\n');
  });
});
