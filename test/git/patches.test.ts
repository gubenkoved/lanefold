import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import { formatPatches, patchFileName } from '../../src/core/repo/patches';
import type { Repository } from '../../src/core/repo/repository';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { BOB, TestRepo } from '../fixtures/repoBuilder';

describe('patches (real git)', () => {
  let test: TestRepo;
  let repo: Repository;
  let ops: RepoOperations;
  let dispose: OpsHarness['dispose'];
  let patchFile: string;

  beforeEach(async () => {
    test = await TestRepo.create();
    await test.commit('base', { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    await test.checkoutNew('topic');
    await test.commit('Change a', { files: { 'a.txt': 'a changed\n' }, author: BOB });
    await test.commit('Change b', { files: { 'b.txt': 'b changed\n' }, author: BOB });
    ({ repo, ops, dispose } = await openOps(test));
    // Newest first, as the graph lists them.
    const shas = [await test.rev('HEAD'), await test.rev('HEAD~1')];
    patchFile = join(test.path, '..', `${Date.now()}-${Math.random()}.patch`);
    await writeFile(patchFile, await formatPatches(repo, shas));
    expect(await patchFileName(repo, shas)).toMatch(/^2-commits-[0-9a-f]{8}\.patch$/);
    expect(await patchFileName(repo, shas.slice(0, 1))).toMatch(/^[0-9a-f]{8}-change-b\.patch$/);
    await test.checkout('main');
  });

  afterEach(() => dispose());

  it('applies a patch’s changes to the working tree and index; Undo takes them back', async () => {
    const plan = await ops.plan({ kind: 'applyPatch', file: patchFile });
    expect(plan.commands[0]!.args).toEqual(['apply', '--3way', '--', patchFile]);
    expect(plan.notices.some((n) => /a\.txt, b\.txt/.test(n.text))).toBe(true);
    await ops.execute(plan.id);
    expect(await test.git('status', '--porcelain')).toBe('M  a.txt\nM  b.txt');
    expect(await test.log('HEAD')).toEqual(['base']);
    expect((await ops.undo()).status).toBe('done');
    expect(await test.git('status', '--porcelain')).toBe('');
  });

  it('recreates the commits in order with their authors (git am); Undo removes them', async () => {
    const plan = await ops.plan({ kind: 'applyPatch', file: patchFile, commit: true });
    expect(plan.commands[0]!.args).toEqual(['am', '--3way', '--', patchFile]);
    expect(plan.changes[0]!.toNew).toBe('2 new commits');
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['Change b', 'Change a', 'base']);
    expect(await test.git('log', '-1', '--format=%an')).toBe(BOB.name);
    expect((await ops.undo()).status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['base']);
  });

  it('refuses a file that is not a patch, and commits from a plain diff', async () => {
    const notPatch = join(test.path, '..', `${Date.now()}.txt`);
    await writeFile(notPatch, 'hello\n');
    expect((await ops.plan({ kind: 'applyPatch', file: notPatch })).blocked).toBe(true);
    const plain = join(test.path, '..', `${Date.now()}.diff`);
    // (The helper trims git's output: put back the final newline a patch needs.)
    await writeFile(plain, `${await test.git('diff', 'main', 'topic')}\n`);
    const plan = await ops.plan({ kind: 'applyPatch', file: plain, commit: true });
    expect(plan.blocked).toBe(true);
    expect(plan.notices.find((n) => n.level === 'danger')!.text).toMatch(/no commits/);
    expect((await ops.plan({ kind: 'applyPatch', file: plain })).blocked).toBeFalsy();
  });
});
