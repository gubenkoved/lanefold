import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import { runPlannedRebase } from '../../src/core/rebase/rewrite';
import type { Repository } from '../../src/core/repo/repository';
import type { OperationPlan, OperationResult } from '../../src/shared/operations';
import { pickAll, type RewriteEntry } from '../../src/shared/rewrite';
import { openOps, REBASE_SCRIPT, type OpsHarness } from '../fixtures/opsHarness';
import { BOB, TestRepo } from '../fixtures/repoBuilder';

describe('history editing (real git)', () => {
  let test: TestRepo;
  let repo: Repository;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];
  /** base, one, two, three, four — oldest first. */
  let c: Record<'base' | 'one' | 'two' | 'three' | 'four', string>;

  beforeEach(async () => {
    test = await TestRepo.create();
    const base = await test.commit('base');
    const one = await test.commit('one');
    const two = await test.commit('two', { author: BOB, files: { 'two.txt': 'two\n' } });
    const three = await test.commit('three');
    const four = await test.commit('four');
    c = { base, one, two, three, four };
    ({ repo, ops, run, dispose } = await openOps(test, { rebaseScript: REBASE_SCRIPT }));
  });

  afterEach(() => dispose());

  async function plan(
    base: string | null,
    entries: RewriteEntry[],
    updateRefs?: boolean,
  ): Promise<OperationPlan> {
    return ops.plan({ kind: 'rewrite', base, entries, updateRefs });
  }

  async function rewrite(
    base: string | null,
    entries: RewriteEntry[],
    updateRefs?: boolean,
  ): Promise<OperationResult> {
    return run({ kind: 'rewrite', base, entries, updateRefs });
  }

  const message = (rev: string) => test.git('log', '-1', '--format=%B', rev);
  const author = (rev: string) => test.git('log', '-1', '--format=%an <%ae> %at', rev);
  const tree = (rev: string) => test.git('rev-parse', `${rev}^{tree}`);

  it('lists the commits after a base, oldest first, with full messages', async () => {
    const range = (await ops.rewriteRange(c.base))!;
    expect(range.commits.map((commit) => commit.subject)).toEqual(['one', 'two', 'three', 'four']);
    expect(range.commits[1]).toMatchObject({ sha: c.two, authorName: BOB.name, parents: [c.one] });
    expect(range.merges).toBe(0);
    expect((await ops.rewriteRange(null))!.commits).toHaveLength(5);
  });

  it('squashes commits into one with both messages, keeping author and date', async () => {
    const headTree = await tree('HEAD');
    const result = await rewrite(c.base, [
      { sha: c.one, action: 'pick' },
      { sha: c.two, action: 'squash' },
      { sha: c.three, action: 'pick' },
      { sha: c.four, action: 'pick' },
    ]);
    expect(result, result.message).toMatchObject({ status: 'done', title: 'Edit history of main' });
    expect(await test.log('HEAD')).toEqual(['four', 'three', 'one', 'base']);
    expect(await message('HEAD~2')).toBe('one\n\ntwo');
    expect(await author('HEAD~2')).toBe(await author(c.one));
    // Same content in the end.
    expect(await tree('HEAD')).toBe(headTree);
    // Which commit each one became.
    const squashed = await test.rev('HEAD~2');
    expect(result.rewritten).toEqual({
      [c.one]: squashed,
      [c.two]: squashed,
      [c.three]: await test.rev('HEAD~1'),
      [c.four]: await test.rev('HEAD'),
    });
    // One undo puts the branch back exactly.
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(c.four);
  });

  it('uses a message chosen for the squashed commit', async () => {
    const result = await rewrite(c.base, [
      { sha: c.one, action: 'pick', message: 'One and two, together\n\nDetails.' },
      { sha: c.two, action: 'squash' },
      { sha: c.three, action: 'pick' },
      { sha: c.four, action: 'pick' },
    ]);
    expect(result.status).toBe('done');
    expect(await message('HEAD~2')).toBe('One and two, together\n\nDetails.');
  });

  it('fixes up a newer commit into an older one, keeping the older message', async () => {
    const result = await rewrite(c.base, [
      { sha: c.one, action: 'pick' },
      { sha: c.four, action: 'fixup' },
      { sha: c.two, action: 'pick' },
      { sha: c.three, action: 'pick' },
    ]);
    expect(result.status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['three', 'two', 'one', 'base']);
    expect(await message('HEAD~2')).toBe('one');
    expect(await test.git('show', '--name-only', '--format=', 'HEAD~2')).toBe('file-2.txt\nfile-4.txt');
  });

  it('rewords a commit without an editor and keeps its author; earlier commits keep their hashes', async () => {
    const planned = await plan(c.base, [
      { sha: c.one, action: 'pick' },
      { sha: c.two, action: 'reword', message: 'Two, explained\n\nWhy it matters.' },
      { sha: c.three, action: 'pick' },
      { sha: c.four, action: 'pick' },
    ]);
    expect(planned.rewrite).toMatchObject({ before: 4, after: 4, rewritten: 3 });
    expect(planned.rewrite!.todo).toBe(
      `pick ${c.one}\npick ${c.two}\nfixup -C <message: “Two, explained”>\npick ${c.three}\npick ${c.four}\n`,
    );
    const result = await ops.execute(planned.id);
    expect(result.status).toBe('done');
    expect(await message('HEAD~2')).toBe('Two, explained\n\nWhy it matters.');
    expect(await author('HEAD~2')).toBe(await author(c.two));
    expect(await test.rev('HEAD~3')).toBe(c.one);
  });

  it('drops and reorders commits', async () => {
    const result = await rewrite(c.base, [
      { sha: c.two, action: 'pick' },
      { sha: c.one, action: 'pick' },
      { sha: c.three, action: 'drop' },
      { sha: c.four, action: 'pick' },
    ]);
    expect(result.status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['four', 'one', 'two', 'base']);
    expect(existsSync(join(test.path, 'file-3.txt'))).toBe(false);
    expect(result.rewritten![c.three]).toBeUndefined();
  });

  it('treats a reword to the same message as no change', async () => {
    const planned = await plan(c.base, [
      { sha: c.one, action: 'reword', message: 'one\n' },
      ...pickAll([{ sha: c.two }, { sha: c.three }, { sha: c.four }]),
    ]);
    expect(planned.blocked).toBe(true);
    expect(planned.notices[0]!.text).toMatch(/Nothing changes/);
  });

  it('stops at an edit line; continuing finishes it and one undo reverts all of it', async () => {
    const result = await rewrite(c.base, [
      { sha: c.one, action: 'pick' },
      { sha: c.two, action: 'edit' },
      { sha: c.three, action: 'pick' },
      { sha: c.four, action: 'pick' },
    ]);
    expect(result, result.message).toMatchObject({ status: 'stopped' });
    const state = await ops.opState();
    expect(state).toMatchObject({ kind: 'rebase', editStop: true, historyEdit: true, branch: 'main' });
    expect(ops.undoInfo.undo).toBeUndefined();

    // Amend the stopped commit, then continue.
    await test.write('extra.txt', 'added while editing\n');
    await test.git('add', 'extra.txt');
    const continued = await ops.execute((await ops.plan({ kind: 'continue' })).id);
    expect(continued, continued.message).toMatchObject({ status: 'done', title: 'Edit history of main' });
    expect(await test.log('HEAD')).toEqual(['four', 'three', 'two', 'one', 'base']);
    expect(await test.git('show', '--name-only', '--format=', 'HEAD~2')).toBe('extra.txt\ntwo.txt');
    expect(continued.rewritten?.[c.two]).toBe(await test.rev('HEAD~2'));
    expect(ops.undoInfo.undo).toBe('Edit history of main');

    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(c.four);
    expect(await test.git('status', '--porcelain')).toBe('');
  });

  it('predicts a conflict at the exact step, stops there, and abort restores the branch', async () => {
    await test.commit('edit shared 1', { files: { 'shared.txt': 'first\n' } });
    await test.commit('edit shared 2', { files: { 'shared.txt': 'second\n' } });
    const head = await test.rev('HEAD');
    const range = (await ops.rewriteRange(c.four))!;
    const [first, second] = range.commits;
    const swapped: RewriteEntry[] = [
      { sha: second!.sha, action: 'pick' },
      { sha: first!.sha, action: 'pick' },
    ];
    const simulation = await ops.simulate(c.four, swapped);
    expect(simulation).toEqual({
      supported: true,
      steps: [
        { sha: second!.sha, status: 'conflict', files: ['shared.txt'] },
        { sha: first!.sha, status: 'unknown' },
      ],
    });
    // Nothing was touched by the dry run.
    expect(await test.rev('HEAD')).toBe(head);
    expect(await test.git('status', '--porcelain')).toBe('');

    const result = await rewrite(c.four, swapped);
    expect(result).toMatchObject({ status: 'conflicts', conflicts: ['shared.txt'] });
    const aborted = await ops.execute((await ops.plan({ kind: 'abort' })).id);
    expect(aborted.status).toBe('done');
    expect(await test.rev('HEAD')).toBe(head);
    expect(await test.git('branch', '--show-current')).toBe('main');
    expect(ops.undoInfo.undo).toBeUndefined();
  });

  it('predicts clean steps and commits that become empty', async () => {
    const simulation = await ops.simulate(c.base, [
      { sha: c.two, action: 'pick' },
      { sha: c.one, action: 'pick' },
      { sha: c.three, action: 'drop' },
      { sha: c.four, action: 'pick' },
    ]);
    expect(simulation.steps.map((step) => step.status)).toEqual(['clean', 'clean', 'clean']);

    const again = await test.commit('one again', { files: { 'file-2.txt': 'one\n' }, allowEmpty: true });
    const empty = await ops.simulate(c.four, [{ sha: again, action: 'pick' }]);
    // Started empty (its change was already there): not reported as becoming empty.
    expect(empty.steps).toEqual([{ sha: again, status: 'clean' }]);
  });

  it('says when a dry run is skipped because there are too many commits to replay live', async () => {
    const many = Array.from({ length: 301 }, (_, i): RewriteEntry => ({
      sha: (i + 1).toString(16).padStart(40, '0'),
      action: 'pick',
    }));
    expect(await ops.simulate(c.base, many)).toEqual({ supported: false, skipped: 'size', steps: [] });
  });

  it('refuses to run when the branch moved after planning', async () => {
    const planned = await plan(c.base, [
      { sha: c.one, action: 'pick' },
      { sha: c.two, action: 'drop' },
      { sha: c.three, action: 'pick' },
      { sha: c.four, action: 'pick' },
    ]);
    await test.commit('made elsewhere');
    expect(await ops.execute(planned.id)).toMatchObject({ status: 'refused', errorKind: 'stale' });
    // Re-planning with the old arrangement is blocked too: the commits no longer match.
    const replanned = await plan(
      c.base,
      pickAll([{ sha: c.one }, { sha: c.two }, { sha: c.three }, { sha: c.four }]),
    );
    expect(replanned.blocked).toBe(true);
    expect(await test.log('HEAD', '%s')).toContain('made elsewhere');
  });

  it('the sequence editor aborts the rebase when git lists other commits than planned', async () => {
    const head = await test.rev('HEAD');
    const attempt = runPlannedRebase(repo, REBASE_SCRIPT, {
      args: ['-i', '--no-autosquash', c.base],
      expected: [c.one, c.two, c.three], // four is missing: the branch "moved"
      entries: [
        { sha: c.one, action: 'pick' },
        { sha: c.three, action: 'pick' },
        { sha: c.two, action: 'pick' },
      ],
      messageOf: () => 'x',
      env: {},
      label: 'test',
      info: {},
    });
    await expect(attempt).rejects.toThrow(/branch changed since the history edit was planned/);
    expect(await test.rev('HEAD')).toBe(head);
    expect((await ops.opState()).kind).toBeUndefined();
  });

  it('moves branches that point into the history along with --update-refs, if asked', async () => {
    await test.branch('topic', c.two);
    await test.tag('v1', { ref: c.three });
    const entries: RewriteEntry[] = [
      { sha: c.one, action: 'pick' },
      { sha: c.two, action: 'squash' },
      { sha: c.three, action: 'pick' },
      { sha: c.four, action: 'pick' },
    ];
    const stays = await plan(c.base, entries);
    expect(stays.rewrite).toMatchObject({ strandedRefs: ['topic', 'v1'], updatedRefs: [] });

    const moves = await plan(c.base, entries, true);
    expect(moves.rewrite).toMatchObject({ strandedRefs: ['v1'], updatedRefs: ['topic'] });
    expect(moves.rewrite!.todo).toContain('update-ref refs/heads/topic');
    expect((await ops.execute(moves.id)).status).toBe('done');
    expect(await test.rev('topic')).toBe(await test.rev('HEAD~2'));
    expect(await test.rev('v1')).toBe(c.three);

    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('topic')).toBe(c.two);
    expect(await test.rev('HEAD')).toBe(c.four);
  });

  it('sets uncommitted changes aside and brings them back', async () => {
    await test.write('file-1.txt', 'work in progress\n');
    const planned = await plan(c.base, [
      { sha: c.one, action: 'pick' },
      { sha: c.two, action: 'pick' },
      { sha: c.three, action: 'fixup' },
      { sha: c.four, action: 'pick' },
    ]);
    expect(planned.commands.at(-1)!.args).toContain('--autostash');
    expect((await ops.execute(planned.id)).status).toBe('done');
    expect(await readFile(join(test.path, 'file-1.txt'), 'utf8')).toBe('work in progress\n');
    expect(await test.log('HEAD')).toEqual(['four', 'two', 'one', 'base']);
  });

  it('undo and redo keep staged changes staged and unstaged ones unstaged', async () => {
    await test.write('new.txt', 'brand new\n');
    await test.write('file-1.txt', 'staged change\n');
    await test.git('add', 'new.txt', 'file-1.txt');
    await test.write('file-4.txt', 'unstaged change\n');
    const head = await test.rev('HEAD');
    expect(
      (
        await rewrite(c.base, [
          ...pickAll([]),
          ...[c.one, c.three, c.two, c.four].map((sha) => ({ sha, action: 'pick' as const })),
        ])
      ).status,
    ).toBe('done');
    // Set aside during the edit, and back exactly as they were (staged or not).
    const before = await test.git('status', '--porcelain');
    expect(before.split('\n').sort()).toEqual([' M file-4.txt', 'A  new.txt', 'M  file-1.txt']);

    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(head);
    expect(await test.git('status', '--porcelain')).toBe(before);
    expect((await ops.redo()).status).toBe('done');
    expect(await test.git('status', '--porcelain')).toBe(before);
  });

  describe('amending an earlier commit with the staged changes', () => {
    it('folds them into it, keeps every message, and undo stages them again', async () => {
      await test.write('file-2.txt', 'one, amended\n');
      await test.git('add', 'file-2.txt');
      await test.write('file-4.txt', 'not staged\n');
      const head = await test.rev('HEAD');
      const planned = await ops.plan({ kind: 'amendInto', commit: c.one });
      expect(planned.blocked, planned.notices.map((n) => n.text).join('\n')).toBeFalsy();
      expect(planned.commands.map((command) => command.args.slice(0, 3))).toEqual([
        ['commit', '-m', `fixup! ${c.one}`],
        ['rebase', '-i', '--autosquash'],
      ]);
      expect(planned.commands[1]!.args).toContain('--autostash');
      expect(planned.conflicts?.predicted).toBeFalsy();
      expect((await ops.execute(planned.id)).status).toBe('done');

      expect(await test.log('HEAD')).toEqual(['four', 'three', 'two', 'one', 'base']);
      expect(await test.git('show', 'HEAD~3:file-2.txt')).toBe('one, amended');
      expect(await test.git('status', '--porcelain')).toBe(' M file-4.txt');

      expect((await ops.undo()).status).toBe('done');
      expect(await test.rev('HEAD')).toBe(head);
      expect((await test.git('status', '--porcelain')).split('\n').sort()).toEqual([
        ' M file-4.txt',
        'M  file-2.txt',
      ]);
    });

    it('amends HEAD directly, and needs something staged', async () => {
      expect((await ops.plan({ kind: 'amendInto', commit: c.two })).notices.map((n) => n.text)).toContain(
        `Stage what belongs in ${c.two.slice(0, 8)} first: only staged changes go into it.`,
      );
      await test.write('file-4.txt', 'four, amended\n');
      await test.git('add', 'file-4.txt');
      const planned = await ops.plan({ kind: 'amendInto', commit: c.four });
      expect(planned.commands.map((command) => command.args)).toEqual([['commit', '--amend', '--no-edit']]);
      expect((await ops.execute(planned.id)).status).toBe('done');
      expect(await test.log('HEAD')).toEqual(['four', 'three', 'two', 'one', 'base']);
      expect(await test.git('status', '--porcelain')).toBe('');
    });

    it('an amend that stops on a conflict and is aborted leaves the changes staged again', async () => {
      await test.write('file-3.txt', 'too early\n');
      await test.git('add', 'file-3.txt');
      const head = await test.rev('HEAD');
      const planned = await ops.plan({ kind: 'amendInto', commit: c.one });
      expect((await ops.execute(planned.id)).status).toBe('conflicts');
      const abort = await ops.plan({ kind: 'abort' });
      expect(abort.commands.map((command) => command.args)).toEqual([
        ['rebase', '--abort'],
        ['reset', '--soft', 'HEAD~1'],
      ]);
      expect((await ops.execute(abort.id)).status).toBe('done');
      expect(await test.rev('HEAD')).toBe(head);
      expect(await test.git('status', '--porcelain')).toBe('M  file-3.txt');
    });

    it('predicts a conflict before anything runs', async () => {
      // "three" created file-3.txt: a change to it cannot go into "one", where it does not exist.
      await test.write('file-3.txt', 'too early\n');
      await test.git('add', 'file-3.txt');
      const planned = await ops.plan({ kind: 'amendInto', commit: c.one });
      expect(planned.conflicts).toEqual({ predicted: true, files: ['file-3.txt'] });
      expect(planned.notices.map((n) => n.text).join('\n')).toContain(
        `The staged changes do not apply cleanly to ${c.one.slice(0, 8)}`,
      );
    });
  });

  it('edits from the root commit', async () => {
    const result = await rewrite(null, [
      { sha: c.base, action: 'pick' },
      { sha: c.one, action: 'fixup' },
      { sha: c.two, action: 'pick' },
      { sha: c.three, action: 'pick' },
      { sha: c.four, action: 'reword', message: 'Four, renamed' },
    ]);
    expect(result.status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['Four, renamed', 'three', 'two', 'base']);
  });

  it('refuses to drop every commit of the history (git would leave an empty commit instead)', async () => {
    const head = await test.rev('HEAD');
    const range = (await ops.rewriteRange(null))!;
    const drops = range.commits.map((commit): RewriteEntry => ({ sha: commit.sha, action: 'drop' }));
    const planned = await plan(null, drops);
    expect(planned.blocked).toBe(true);
    expect(planned.notices.map((notice) => notice.text).join('\n')).toMatch(/a branch needs at least one/);
    // After a base, dropping all of it is fine: the branch goes back to the base.
    const result = await rewrite(c.base, drops.slice(1));
    expect(result.status, result.message).toBe('done');
    expect(await test.rev('HEAD')).toBe(c.base);
    expect(head).not.toBe(c.base);
  });

  it('follows the plan whatever the user’s rebase settings say', async () => {
    for (const [key, value] of [
      ['rebase.autoSquash', 'true'],
      ['rebase.updateRefs', 'true'],
      ['rebase.abbreviateCommands', 'true'],
      ['rebase.instructionFormat', '%s by %an'],
      ['rebase.missingCommitsCheck', 'error'],
      ['rebase.autoStash', 'true'],
      ['core.commentChar', ';'],
      ['commit.cleanup', 'verbatim'],
      ['sequence.editor', 'false'],
      ['core.editor', 'false'],
    ]) {
      await test.git('config', key!, value!);
    }
    await test.branch('topic', c.two);
    // "fixup! one" would be moved by autosquash if it were not turned off.
    const fixup = await test.commit('fixup! one');
    const result = await rewrite(c.base, [
      { sha: c.one, action: 'pick' },
      { sha: c.two, action: 'reword', message: 'Two, reworded' },
      { sha: c.three, action: 'squash' },
      { sha: c.four, action: 'pick' },
      { sha: fixup, action: 'pick' },
    ]);
    expect(result, result.message).toMatchObject({ status: 'done' });
    expect(await test.log('HEAD')).toEqual(['fixup! one', 'four', 'Two, reworded', 'one', 'base']);
    expect(await message('HEAD~2')).toBe('Two, reworded');
    // --no-update-refs wins over rebase.updateRefs.
    expect(await test.rev('topic')).toBe(c.two);
  });

  it('refuses histories with merge commits', async () => {
    await test.checkoutNew('side', c.three);
    await test.commit('side work');
    await test.checkout('main');
    await test.merge('side', { noFF: true });
    const range = (await ops.rewriteRange(c.base))!;
    expect(range.merges).toBe(1);
    const planned = await plan(c.base, pickAll(range.commits));
    expect(planned.blocked).toBe(true);
    expect(planned.notices[0]!.text).toMatch(/merge commit/);
  });
});
