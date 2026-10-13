import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RepoOperations } from '../../src/core/ops/operations';
import { literalPathArgs } from '../../src/core/rebase/split';
import type { Repository } from '../../src/core/repo/repository';
import type { Operation, OperationResult } from '../../src/shared/operations';
import type { RewriteEntry } from '../../src/shared/rewrite';
import { openOps, REBASE_SCRIPT, type OpsHarness } from '../fixtures/opsHarness';
import { ALICE, BOB, TestRepo } from '../fixtures/repoBuilder';

describe('splitting a commit in a history edit (real git)', () => {
  let test: TestRepo;
  let repo: Repository;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];
  /** base, one, two (Bob: model.txt + view.txt), three, four (four-a.txt + four-b.txt). */
  let c: Record<'base' | 'one' | 'two' | 'three' | 'four', string>;

  beforeEach(async () => {
    test = await TestRepo.create();
    const base = await test.commit('base');
    const one = await test.commit('one');
    const two = await test.commit('two', {
      author: BOB,
      files: { 'model.txt': 'model\n', 'view.txt': 'view\n' },
    });
    const three = await test.commit('three');
    const four = await test.commit('four', { files: { 'four-a.txt': 'a\n', 'four-b.txt': 'b\n' } });
    c = { base, one, two, three, four };
    ({ repo, ops, run, dispose } = await openOps(test, { rebaseScript: REBASE_SCRIPT }));
  });

  afterEach(() => dispose());

  const short = (sha: string) => sha.slice(0, 8);
  const author = (rev: string) => test.git('log', '-1', '--format=%an <%ae> %at', rev);
  const files = (rev: string) => test.git('show', '--name-only', '--format=', rev);
  const tree = (rev: string) => test.git('rev-parse', `${rev}^{tree}`);
  const status = () => test.git('status', '--porcelain');

  /** The history after `base`, oldest first: every commit picked except those to split. */
  const arrange = (...splits: string[]): RewriteEntry[] =>
    [c.one, c.two, c.three, c.four].map((sha) => ({ sha, action: splits.includes(sha) ? 'split' : 'pick' }));

  /** Starts a history edit that splits the given commits; git stops at the first one. */
  async function split(...shas: string[]): Promise<OperationResult> {
    const result = await run({ kind: 'rewrite', base: c.base, entries: arrange(...shas) });
    expect(result, result.message).toMatchObject({ status: 'stopped' });
    return result;
  }

  async function commitPart(message: string, ...paths: string[]): Promise<OperationResult> {
    await test.git('add', '-A', '--', ...paths);
    const result = await run({ kind: 'commit', message });
    expect(result, result.message).toMatchObject({ status: 'done' });
    return result;
  }

  it('plans a split as an edit stop that takes the commit apart', async () => {
    const planned = await ops.plan({ kind: 'rewrite', base: c.base, entries: arrange(c.two) });
    expect(planned.blocked).toBeFalsy();
    expect(planned.rewrite!.todo).toBe(`pick ${c.one}\nedit ${c.two}\npick ${c.three}\npick ${c.four}\n`);
    expect(planned.rewrite).toMatchObject({ before: 4, after: 4, splits: 1 });
    expect(planned.notices.map((notice) => notice.text)).toContainEqual(
      expect.stringMatching(new RegExp(`^Stops at ${short(c.two)} with its changes uncommitted`)),
    );
    expect(planned.changes[0]).toMatchObject({ toNew: '4 or more rewritten commits' });
    // The dry run treats it like a pick.
    const simulation = await ops.simulate(c.base, arrange(c.two));
    expect(simulation.steps.map((step) => step.status)).toEqual(['clean', 'clean', 'clean', 'clean']);
  });

  it('splits a commit in two by file: the rest keeps its message, author and date; one Undo reverts all', async () => {
    const head = await test.rev('HEAD');
    const headTree = await tree('HEAD');
    const result = await split(c.two);
    expect(result.message).toMatch(/^Splitting .*: its changes are uncommitted now/);
    expect(await ops.opState()).toMatchObject({
      kind: 'rebase',
      historyEdit: true,
      split: { commit: c.two, subject: 'two', message: 'two', opened: true, parts: [] },
      changes: { staged: 0, untracked: 2 },
    });
    // Its parent is checked out, its changes are back in the working tree.
    expect(await test.rev('HEAD')).toBe(c.one);
    expect(await status()).toBe('?? model.txt\n?? view.txt');
    expect(ops.undoInfo.undo).toBeUndefined();

    const part = await commitPart('Add the model', 'model.txt');
    expect(part).toMatchObject({ title: `Commit part 1 of ${short(c.two)}` });
    expect(part.entry).toBeUndefined();
    expect((await ops.opState()).split).toMatchObject({
      opened: true,
      parts: [{ sha: await test.rev('HEAD'), subject: 'Add the model' }],
    });

    const finish = await ops.plan({ kind: 'continue' });
    expect(finish.title).toBe(`Finish splitting ${short(c.two)}`);
    expect(finish.commands.map((command) => command.args.join(' '))).toEqual([
      'add -A -- view.txt',
      `commit -C ${c.two}`,
      'rebase --continue',
    ]);
    const done = await ops.execute(finish.id);
    expect(done, done.message).toMatchObject({ status: 'done', title: 'Edit history of main' });
    expect(await test.log('HEAD')).toEqual(['four', 'three', 'two', 'Add the model', 'one', 'base']);
    expect(await files('HEAD~3')).toBe('model.txt');
    expect(await files('HEAD~2')).toBe('view.txt');
    // The part is the user's; what was left is the original commit's, author and date included.
    expect(await test.git('log', '-1', '--format=%an', 'HEAD~3')).toBe(ALICE.name);
    expect(await author('HEAD~2')).toBe(await author(c.two));
    expect(await tree('HEAD')).toBe(headTree);
    expect(await status()).toBe('');
    expect(done.rewritten?.[c.two]).toBe(await test.rev('HEAD~2'));
    expect(done.rewritten?.[c.three]).toBe(await test.rev('HEAD~1'));

    expect(ops.undoInfo.undo).toBe('Edit history of main');
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(head);
    expect(await test.git('branch', '--show-current')).toBe('main');
    expect(await status()).toBe('');
  });

  it('splits part of a file’s changes, staged with plain git', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    const text = (edit: (all: string[]) => void) => {
      const copy = [...lines];
      edit(copy);
      return `${copy.join('\n')}\n`;
    };
    await test.commit('shared', { files: { 'shared.txt': text(() => {}) } });
    const both = text((all) => {
      all[0] = 'line 1, changed';
      all[11] = 'line 12, changed';
    });
    const original = await test.commit('two changes\n\nThe first and the last line, for two reasons.', {
      author: BOB,
      files: { 'shared.txt': both },
    });
    await test.commit('later');
    const range = (await ops.rewriteRange(c.four))!;
    const result = await run({
      kind: 'rewrite',
      base: c.four,
      entries: range.commits.map((commit) => ({
        sha: commit.sha,
        action: commit.sha === original ? 'split' : 'pick',
      })),
    });
    expect(result.status).toBe('stopped');
    expect(await status()).toBe(' M shared.txt');

    // The first change only, through the index (the working tree keeps both).
    const first = text((all) => {
      all[0] = 'line 1, changed';
    });
    await test.write('shared.txt', first);
    await test.git('add', 'shared.txt');
    await test.write('shared.txt', both);
    await test.git('commit', '-q', '-m', 'Change the first line');
    expect((await ops.opState()).split?.parts.map((part) => part.subject)).toEqual(['Change the first line']);

    const done = await run({ kind: 'continue' });
    expect(done, done.message).toMatchObject({ status: 'done' });
    expect(await test.log('HEAD', '%s')).toEqual([
      'later',
      'two changes',
      'Change the first line',
      'shared',
      'four',
      'three',
      'two',
      'one',
      'base',
    ]);
    expect(await test.git('show', 'HEAD~2:shared.txt')).toBe(first.trimEnd());
    expect(await test.git('show', 'HEAD~1:shared.txt')).toBe(both.trimEnd());
    expect(await author('HEAD~1')).toBe(await author(original));
    expect(await test.git('log', '-1', '--format=%B', 'HEAD~1')).toBe(
      'two changes\n\nThe first and the last line, for two reasons.',
    );
  });

  it('finishes a split that renames a file: both sides of the rename go into what is left', async () => {
    await test.git('mv', 'model.txt', 'model-renamed.txt');
    const renamed = await test.commit('Rename the model', { files: { 'view.txt': 'view, edited\n' } });
    const result = await run({ kind: 'rewrite', base: c.four, entries: [{ sha: renamed, action: 'split' }] });
    expect(result.status).toBe('stopped');
    await commitPart('Edit the view', 'view.txt');
    const finish = await ops.plan({ kind: 'continue' });
    expect(finish.commands.map((command) => command.args.join(' '))).toEqual([
      'add -A -- model.txt model-renamed.txt',
      `commit -C ${renamed}`,
      'rebase --continue',
    ]);
    expect((await ops.execute(finish.id)).status).toBe('done');
    expect(await test.log('HEAD', '%s')).toEqual([
      'Rename the model',
      'Edit the view',
      'four',
      'three',
      'two',
      'one',
      'base',
    ]);
    expect(await test.git('show', '-M', '--name-status', '--format=', 'HEAD')).toBe(
      'R100\tmodel.txt\tmodel-renamed.txt',
    );
    expect(await status()).toBe('');
  });

  it('keeps a file the commit holds although git ignores it', async () => {
    await test.write('.gitignore', '*.log\n');
    await test.write('keep.log', 'kept\n');
    await test.git('add', '.gitignore');
    await test.git('add', '-f', 'keep.log');
    await test.git('commit', '-q', '-m', 'Ignore logs but one');
    const ignoring = await test.rev('HEAD');
    const result = await run({
      kind: 'rewrite',
      base: c.four,
      entries: [{ sha: ignoring, action: 'split' }],
    });
    expect(result.status).toBe('stopped');
    // Taken apart, the log is untracked and ignored: Continue still puts it back.
    await commitPart('Ignore logs', '.gitignore');
    const finish = await ops.plan({ kind: 'continue' });
    expect(finish.commands.map((command) => command.args.join(' '))).toEqual([
      'add -A -f -- keep.log',
      `commit -C ${ignoring}`,
      'rebase --continue',
    ]);
    expect((await ops.execute(finish.id)).status).toBe('done');
    expect(await files('HEAD')).toBe('keep.log');
    expect(await files('HEAD~1')).toBe('.gitignore');
  });

  it('reports a refused commit of what is left, and continues once it can', async () => {
    await split(c.two);
    await commitPart('Add the model', 'model.txt');
    await test.write('.git/hooks/pre-commit', '#!/bin/sh\necho "no commits today" >&2\nexit 1\n');
    await chmod(join(test.path, '.git/hooks/pre-commit'), 0o755);
    const refused = await run({ kind: 'continue' });
    expect(refused).toMatchObject({ status: 'failed', message: 'no commits today' });
    // Still splitting, with what is left staged.
    expect((await ops.opState()).split).toMatchObject({ commit: c.two, opened: true });
    expect(await test.git('diff', '--cached', '--name-only')).toBe('view.txt');

    await test.remove('.git/hooks/pre-commit');
    const finish = await ops.plan({ kind: 'continue' });
    expect(finish.commands.map((command) => command.args.join(' '))).toEqual([
      `commit -C ${c.two}`,
      'rebase --continue',
    ]);
    expect((await ops.execute(finish.id)).status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['four', 'three', 'two', 'Add the model', 'one', 'base']);
  });

  it('aborting mid-split puts the history and the files back', async () => {
    const head = await test.rev('HEAD');
    await split(c.two);
    await commitPart('Add the model', 'model.txt');
    const abort = await ops.plan({ kind: 'abort' });
    expect(abort.notices.map((notice) => notice.text)).toContainEqual(
      expect.stringMatching(/^The part committed so far goes too/),
    );
    // Git would not overwrite the commit's new file, untracked since it was taken apart.
    expect(abort.commands.map((command) => command.args.join(' '))).toEqual([
      'add -A -- view.txt',
      'rebase --abort',
    ]);
    const aborted = await ops.execute(abort.id);
    expect(aborted, aborted.message).toMatchObject({ status: 'done' });
    expect(await test.rev('HEAD')).toBe(head);
    expect(await test.git('branch', '--show-current')).toBe('main');
    expect(await status()).toBe('');
    // Nothing was changed since the last step: nothing needed saving.
    expect(await test.git('stash', 'list')).toBe('');
    expect(ops.undoInfo.undo).toBeUndefined();
  });

  it('aborting after changing files saves those changes first', async () => {
    await split(c.two);
    await test.write('view.txt', 'view, edited while splitting\n');
    expect((await run({ kind: 'abort' })).message).toMatch(/saved as stash@\{0\}/);
    expect(await test.rev('HEAD')).toBe(c.four);
    expect(await test.git('stash', 'list')).toMatch(/Lanefold: changes saved before “Stop editing history”/);
  });

  it('splits the newest commit', async () => {
    await split(c.four);
    expect(await test.rev('HEAD')).toBe(c.three);
    await commitPart('Add a', 'four-a.txt');
    const done = await run({ kind: 'continue' });
    expect(done.status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['four', 'Add a', 'three', 'two', 'one', 'base']);
    expect(await files('HEAD')).toBe('four-b.txt');
    expect(await author('HEAD')).toBe(await author(c.four));
  });

  it('sets uncommitted changes aside while splitting and brings them back at the end', async () => {
    await test.write('file-1.txt', 'work in progress\n');
    await split(c.two);
    // Only the commit's changes are in the working tree meanwhile.
    expect(await status()).toBe('?? model.txt\n?? view.txt');
    await commitPart('Add the model', 'model.txt');
    expect((await run({ kind: 'continue' })).status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['four', 'three', 'two', 'Add the model', 'one', 'base']);
    expect(await readFile(join(test.path, 'file-1.txt'), 'utf8')).toBe('work in progress\n');
  });

  it('continues with nothing left: the parts replace the commit', async () => {
    await split(c.two);
    await commitPart('Add the model', 'model.txt');
    await commitPart('Add the view', 'view.txt');
    const finish = await ops.plan({ kind: 'continue' });
    expect(finish.commands.map((command) => command.args.join(' '))).toEqual(['rebase --continue']);
    expect(finish.notices.map((notice) => notice.text)).toContainEqual(
      expect.stringMatching(/^Nothing is left of .*: its 2 parts replace it/),
    );
    const done = await ops.execute(finish.id);
    expect(done.status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['four', 'three', 'Add the view', 'Add the model', 'one', 'base']);
    // The commit maps to its last part.
    expect(done.rewritten?.[c.two]).toBe(await test.rev('HEAD~2'));
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(c.four);
  });

  it('splits several commits in one edit, taking each apart as git gets there', async () => {
    await split(c.two, c.four);
    await commitPart('Add the model', 'model.txt');
    const next = await run({ kind: 'continue' });
    expect(next, next.message).toMatchObject({ status: 'stopped' });
    expect(next.message).toMatch(new RegExp(`^Splitting ${short(c.four)}`));
    expect((await ops.opState()).split).toMatchObject({ commit: c.four, opened: true, parts: [] });
    await commitPart('Add a', 'four-a.txt');
    const done = await run({ kind: 'continue' });
    expect(done.status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['four', 'Add a', 'three', 'two', 'Add the model', 'one', 'base']);
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(c.four);
  });

  it('finds the split whatever the user’s rebase settings say', async () => {
    await test.git('config', 'rebase.abbreviateCommands', 'true');
    await test.git('config', 'rebase.instructionFormat', '%s by %an');
    await split(c.two);
    expect(await test.git('log', '-1', '--format=%s', 'HEAD')).toBe('one');
    expect((await ops.opState()).split).toMatchObject({ commit: c.two, opened: true });
    await commitPart('Add the model', 'model.txt');
    expect((await run({ kind: 'continue' })).status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['four', 'three', 'two', 'Add the model', 'one', 'base']);
  });

  it('continued from a terminal, the next split waits to be started from the banner', async () => {
    await split(c.two, c.four);
    // Finished by hand: what is left, as the original, then on to the next stop.
    await test.git('add', '-A');
    await test.git('commit', '-q', '-C', c.two);
    await test.git('rebase', '--continue');
    const stopped = await ops.opState();
    expect(stopped).toMatchObject({ editStop: true, split: { commit: c.four, opened: false, parts: [] } });
    expect(await test.rev('HEAD')).not.toBe(c.three);

    // Continue would keep it whole; Split takes it apart.
    expect((await ops.plan({ kind: 'continue' })).notices.map((notice) => notice.text)).toContainEqual(
      expect.stringMatching(/stays whole/),
    );
    const start = await ops.plan({ kind: 'startSplit' });
    expect(start).toMatchObject({ title: `Split ${short(c.four)}`, destructive: false });
    expect(start.commands.map((command) => command.args.join(' '))).toEqual(['reset --mixed HEAD~1']);
    const started = await ops.execute(start.id);
    expect(started.message).toMatch(/^Splitting /);
    expect((await ops.opState()).split).toMatchObject({ commit: c.four, opened: true });
    expect(await status()).toBe('?? four-a.txt\n?? four-b.txt');

    // A part made in the terminal counts too.
    await test.git('add', 'four-a.txt');
    await test.git('commit', '-q', '-m', 'Add a');
    expect((await ops.opState()).split?.parts.map((part) => part.subject)).toEqual(['Add a']);
    const done = await run({ kind: 'continue' });
    expect(done, done.message).toMatchObject({ status: 'done', title: 'Edit history of main' });
    expect(await test.log('HEAD')).toEqual(['four', 'Add a', 'three', 'two', 'one', 'base']);
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(c.four);
  });

  it('aborting where a terminal left the edit, with nothing uncommitted, saves nothing first', async () => {
    await split(c.two, c.four);
    await test.git('add', '-A');
    await test.git('commit', '-q', '-C', c.two);
    await test.git('rebase', '--continue');
    const abort = await ops.plan({ kind: 'abort' });
    expect(abort.destructive).toBe(false);
    expect((await ops.execute(abort.id)).status).toBe('done');
    expect(await test.git('stash', 'list')).toBe('');
    expect(await test.rev('HEAD')).toBe(c.four);
  });

  it('a split taken apart by hand (git reset HEAD~1) counts as started', async () => {
    await split(c.two, c.four);
    await test.git('add', '-A');
    await test.git('commit', '-q', '-C', c.two);
    await test.git('rebase', '--continue');
    await test.git('reset', '-q', 'HEAD~1');
    expect((await ops.opState()).split).toMatchObject({ commit: c.four, opened: true, parts: [] });
    expect((await ops.plan({ kind: 'startSplit' })).blocked).toBe(true);
    expect((await run({ kind: 'continue' })).status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['four', 'three', 'two', 'one', 'base']);
    expect(await author('HEAD')).toBe(await author(c.four));
  });

  it('splits a commit git stopped at with a conflict, once it is resolved', async () => {
    await test.commit('add shared', { files: { 'shared.txt': 'first\n' } });
    const changed = await test.commit('change shared', {
      author: BOB,
      files: { 'shared.txt': 'second\n', 'extra.txt': 'extra\n' },
    });
    const range = (await ops.rewriteRange(c.four))!;
    const result = await run({
      kind: 'rewrite',
      base: c.four,
      entries: [
        { sha: range.commits[0]!.sha, action: 'drop' },
        { sha: changed, action: 'split' },
      ],
    });
    expect(result).toMatchObject({ status: 'conflicts', conflicts: ['shared.txt'] });
    expect((await ops.opState()).split).toMatchObject({ commit: changed, opened: false });
    expect((await ops.plan({ kind: 'startSplit' })).blocked).toBe(true);

    await test.write('shared.txt', 'second\n');
    await test.git('add', 'shared.txt');
    const start = await ops.plan({ kind: 'startSplit' });
    expect(start.commands.map((command) => command.args.join(' '))).toEqual(['reset --mixed']);
    expect((await ops.execute(start.id)).message).toMatch(/^Splitting /);
    expect(await status()).toBe('?? extra.txt\n?? shared.txt');

    await commitPart('Add extra', 'extra.txt');
    const done = await run({ kind: 'continue' });
    expect(done, done.message).toMatchObject({ status: 'done' });
    expect(await test.log('HEAD')).toEqual([
      'change shared',
      'Add extra',
      'four',
      'three',
      'two',
      'one',
      'base',
    ]);
    expect(await author('HEAD')).toBe(await author(changed));
    expect(await test.git('show', 'HEAD:shared.txt')).toBe('second');
  });

  it('stops on a conflict further on, after the split; finishing it finishes the edit', async () => {
    const shared = await test.commit('add shared', { files: { 'shared.txt': 'first\n' } });
    const both = await test.commit('add a and b', { author: BOB, files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    const change = await test.commit('change shared', { files: { 'shared.txt': 'second\n' } });
    const result = await run({
      kind: 'rewrite',
      base: c.four,
      entries: [
        { sha: shared, action: 'drop' },
        { sha: both, action: 'split' },
        { sha: change, action: 'pick' },
      ],
    });
    expect(result.status).toBe('stopped');
    await commitPart('Add a', 'a.txt');
    // What is left of the split goes in, then the next commit conflicts (its file was dropped).
    const next = await run({ kind: 'continue' });
    expect(next).toMatchObject({ status: 'conflicts', conflicts: ['shared.txt'] });
    const state = await ops.opState();
    expect(state.split).toBeUndefined();
    expect(state.conflicts).toEqual(['shared.txt']);

    await test.write('shared.txt', 'second\n');
    await test.git('add', 'shared.txt');
    expect((await run({ kind: 'continue' })).status).toBe('done');
    expect(await test.log('HEAD')).toEqual([
      'change shared',
      'add a and b',
      'Add a',
      'four',
      'three',
      'two',
      'one',
      'base',
    ]);
    expect(await files('HEAD~1')).toBe('b.txt');
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(change);
  });

  it('splits a commit again: after an abort, and what was left of it once finished', async () => {
    await split(c.two);
    await commitPart('Add the model', 'model.txt');
    expect((await run({ kind: 'abort' })).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(c.four);

    // From the start again: nothing of the first attempt is left over.
    await split(c.two);
    expect((await ops.opState()).split).toMatchObject({ commit: c.two, opened: true, parts: [] });
    await commitPart('Add the model', 'model.txt');
    expect((await run({ kind: 'continue' })).status).toBe('done');

    // What was left ("two", with view.txt) is a commit like any other: split it too.
    const part = await test.rev('HEAD~3');
    const rest = await test.rev('HEAD~2');
    const range = (await ops.rewriteRange(part))!;
    expect(range.commits.map((commit) => commit.subject)).toEqual(['two', 'three', 'four']);
    const again = await run({
      kind: 'rewrite',
      base: part,
      entries: range.commits.map((commit) => ({
        sha: commit.sha,
        action: commit.sha === rest ? 'split' : 'pick',
      })),
    });
    expect(again.status).toBe('stopped');
    expect((await ops.opState()).split).toMatchObject({ commit: rest, opened: true });
    await commitPart('Add the view', 'view.txt');
    expect((await run({ kind: 'continue' })).status).toBe('done');
    expect(await test.log('HEAD')).toEqual(['four', 'three', 'Add the view', 'Add the model', 'one', 'base']);
  });

  it('splits the first commit after a merge; starting before the merge is refused', async () => {
    await test.checkoutNew('side', c.three);
    await test.commit('side work');
    await test.checkout('main');
    const merge = await test.merge('side', { noFF: true });
    const after = await test.commit('after the merge', { files: { 'x.txt': 'x\n', 'y.txt': 'y\n' } });
    const result = await run({ kind: 'rewrite', base: merge, entries: [{ sha: after, action: 'split' }] });
    expect(result.status).toBe('stopped');
    await commitPart('Add x', 'x.txt');
    expect((await run({ kind: 'continue' })).status).toBe('done');
    expect(await test.log('HEAD~2..HEAD')).toEqual(['after the merge', 'Add x']);
    expect(await test.rev('HEAD~2')).toBe(merge);

    const range = (await ops.rewriteRange(c.two))!;
    expect(range.merges).toBe(1);
    const before = await ops.plan({
      kind: 'rewrite',
      base: c.two,
      entries: range.commits.map((commit) => ({ sha: commit.sha, action: 'split' as const })),
    });
    expect(before.blocked).toBe(true);
    expect(before.notices[0]!.text).toMatch(/merge commit/);
  });

  it('moves a branch at the split commit to what is left of it, with --update-refs', async () => {
    await test.branch('topic', c.two);
    const planned = await ops.plan({
      kind: 'rewrite',
      base: c.base,
      entries: arrange(c.two),
      updateRefs: true,
    });
    expect(planned.rewrite!.todo).toContain(`edit ${c.two}\nupdate-ref refs/heads/topic\n`);
    expect((await ops.execute(planned.id)).status).toBe('stopped');
    await commitPart('Add the model', 'model.txt');
    expect((await run({ kind: 'continue' })).status).toBe('done');
    expect(await test.log('topic')).toEqual(['two', 'Add the model', 'one', 'base']);
    // One Undo puts both branches back.
    expect((await ops.undo()).status).toBe('done');
    expect(await test.rev('HEAD')).toBe(c.four);
    expect(await test.rev('topic')).toBe(c.two);
  });

  it('refuses what cannot work, with the reason', async () => {
    const reason = async (operation: Operation) => {
      const planned = await ops.plan(operation);
      expect(planned.blocked).toBe(true);
      return planned.notices.find((notice) => notice.level === 'danger')?.text;
    };
    // The first commit has no parent to go back to.
    expect(
      await reason({
        kind: 'rewrite',
        base: null,
        entries: [{ sha: c.base, action: 'split' }, ...arrange()],
      }),
    ).toMatch(/first commit of the history cannot be split/);
    // Nothing can be folded into a commit being split.
    expect(
      await reason({
        kind: 'rewrite',
        base: c.base,
        entries: [
          { sha: c.one, action: 'pick' },
          { sha: c.two, action: 'split' },
          { sha: c.three, action: 'fixup' },
          { sha: c.four, action: 'pick' },
        ],
      }),
    ).toMatch(/cannot have other commits folded into it/);
    expect(await reason({ kind: 'startSplit' })).toMatch(/No operation is in progress/);

    await split(c.two);
    expect(await reason({ kind: 'skip' })).toMatch(/Skipping would leave out/);
    expect(await reason({ kind: 'startSplit' })).toMatch(/taken apart already/);
    await test.git('add', 'model.txt');
    expect(await reason({ kind: 'commit', message: 'x', amend: true })).toMatch(/Amending is not available/);
    // Only committing parts goes on mid-edit.
    expect(await reason({ kind: 'createBranch', name: 'topic', at: 'HEAD' })).toMatch(
      /rebase is in progress/,
    );
    // A change to a file the commit does not touch must be dealt with first.
    await test.write('file-1.txt', 'changed while splitting\n');
    expect(await reason({ kind: 'continue' })).toMatch(/^file-1\.txt changed too, but is not part of/);
  });

  it('stages a long list of exact paths from stdin', async () => {
    await test.write('*.txt', 'star\n');
    await test.write('b.txt', 'b\n');
    await test.write('c.txt', 'c\n');
    const { args, stdin } = literalPathArgs(['*.txt', 'b.txt'], 10);
    expect(args).toEqual(['--pathspec-from-file=-', '--pathspec-file-nul']);
    await repo.git(['add', '-A', ...args], { stdin });
    expect((await test.git('diff', '--cached', '--name-only')).split('\n')).toEqual(['*.txt', 'b.txt']);
    expect(literalPathArgs(['*.txt', 'b.txt'])).toEqual({ args: ['--', ':(literal)*.txt', 'b.txt'] });
  });
});
