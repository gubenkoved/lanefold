import { chmod, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HarnessPlatform } from '../../dev/harness/platform';
import { Backend } from '../../src/core/backend/backend';
import { ConsoleLog } from '../../src/core/console/consoleLog';
import type { RepoOperations } from '../../src/core/ops/operations';
import { RepositoryRegistry } from '../../src/core/repo/registry';
import {
  applyToIndex,
  linePatchFor,
  patchBytes,
  readFileDiff,
  toFileHunks,
  type LineRequest,
} from '../../src/core/repo/lineStaging';
import { Repository } from '../../src/core/repo/repository';
import type { DiffArea, DiffLineKind, FileHunks, LineRef, LineSelection } from '../../src/shared/hunks';
import type { OperationResult } from '../../src/shared/operations';
import type { RpcMessage, RpcTransport } from '../../src/shared/rpc';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

const lines = (...texts: string[]) => texts.map((text) => `${text}\n`).join('');
const BASE = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l');
/** b → B and X after c (first hunk); k → K and m at the end (second hunk). */
const EDITED = lines('a', 'B', 'c', 'X', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K', 'l', 'm');

describe('hunk and line staging (real git)', () => {
  let test: TestRepo;
  let repo: Repository;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];

  beforeEach(async () => {
    test = await TestRepo.create();
    await test.commit('base', { files: { 'f.txt': BASE } });
    ({ repo, ops, run, dispose } = await openOps(test));
  });

  afterEach(() => dispose());

  const read = (file: string) => readFile(join(test.path, file), 'utf8');
  const bytes = (file: string) => readFile(join(test.path, file));
  const staged = (file: string) => test.gitRaw('show', `:${file}`);
  /** `git diff` output without its "index" line (blob hashes). */
  const diffOf = async (...args: string[]) =>
    (await test.gitRaw('diff', ...args)).replace(/^index .*\n/m, '');

  /** The position of the line with this text in the file's diff as shown. */
  async function refOf(file: string, area: DiffArea, kind: DiffLineKind, text: string): Promise<LineRef> {
    const hunks = toFileHunks(await readFileDiff(repo, file, area)).hunks;
    for (const [hunk, { lines: hunkLines }] of hunks.entries()) {
      const line = hunkLines.findIndex((l) => l.kind === kind && l.text === text);
      if (line >= 0) return { hunk, line };
    }
    throw new Error(`No ${kind} line “${text}” in the diff of ${file}`);
  }

  async function request(file: string, area: DiffArea, selection: LineSelection): Promise<LineRequest> {
    return { path: file, area, fingerprint: (await readFileDiff(repo, file, area)).fingerprint, selection };
  }

  async function stage(file: string, selection: LineSelection, area: DiffArea = 'unstaged'): Promise<void> {
    await applyToIndex(
      repo,
      await linePatchFor(repo, await request(file, area, selection), false),
      false,
      'Stage',
    );
  }

  async function unstage(file: string, selection: LineSelection): Promise<void> {
    await applyToIndex(
      repo,
      await linePatchFor(repo, await request(file, 'staged', selection), true),
      true,
      'Unstage',
    );
  }

  async function discard(file: string, selection: LineSelection): Promise<OperationResult> {
    const { fingerprint } = await readFileDiff(repo, file, 'unstaged');
    return run({ kind: 'discardLines', path: file, fingerprint, selection });
  }

  it('stages selected lines: the index gets exactly those, the working tree keeps everything', async () => {
    await test.write('f.txt', EDITED);
    await stage('f.txt', {
      lines: [await refOf('f.txt', 'unstaged', 'added', 'X'), await refOf('f.txt', 'unstaged', 'added', 'm')],
    });
    expect(await staged('f.txt')).toBe(
      lines('a', 'b', 'c', 'X', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'),
    );
    expect(await diffOf('--cached')).toBe(
      lines(
        'diff --git a/f.txt b/f.txt',
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,6 +1,7 @@',
        ' a',
        ' b',
        ' c',
        '+X',
        ' d',
        ' e',
        ' f',
        // git's default hunk header: the last line before the hunk that starts with a letter.
        '@@ -10,3 +11,4 @@ i',
        ' j',
        ' k',
        ' l',
        '+m',
      ),
    );
    expect(await read('f.txt')).toBe(EDITED);
    // What is left unstaged: the other changes, against the new index.
    const left = toFileHunks(await readFileDiff(repo, 'f.txt', 'unstaged'));
    expect(
      left.hunks.flatMap((h) =>
        h.lines.filter((l) => l.kind !== 'context').map((l) => `${l.kind} ${l.text}`),
      ),
    ).toEqual(['removed b', 'added B', 'removed k', 'added K']);
  });

  it('stages and unstages whole hunks', async () => {
    await test.write('f.txt', EDITED);
    await stage('f.txt', { hunks: [1] });
    expect(await staged('f.txt')).toBe(
      lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K', 'l', 'm'),
    );
    await stage('f.txt', { hunks: [0] });
    expect(await staged('f.txt')).toBe(EDITED);
    expect(await test.git('status', '--porcelain')).toBe('M  f.txt');
    await unstage('f.txt', { hunks: [0] });
    expect(await staged('f.txt')).toBe(
      lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K', 'l', 'm'),
    );
    expect(await read('f.txt')).toBe(EDITED);
  });

  it('unstages selected lines; they stay in the working tree', async () => {
    await test.write('f.txt', EDITED);
    await test.git('add', 'f.txt');
    await unstage('f.txt', {
      lines: [await refOf('f.txt', 'staged', 'added', 'X'), await refOf('f.txt', 'staged', 'removed', 'k')],
    });
    // X is no longer staged; k is back next to K (only its removal was taken back).
    expect(await staged('f.txt')).toBe(
      lines('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'K', 'l', 'm'),
    );
    expect(await read('f.txt')).toBe(EDITED);
  });

  it('discards selected lines after review; Undo puts the file back exactly', async () => {
    await test.write('f.txt', EDITED);
    await test.git('add', 'f.txt');
    await test.write('f.txt', `${EDITED}n\n`);
    const before = await bytes('f.txt');
    const selection = {
      lines: [await refOf('f.txt', 'unstaged', 'added', 'n')],
    };
    const { fingerprint } = await readFileDiff(repo, 'f.txt', 'unstaged');
    const plan = await ops.plan({ kind: 'discardLines', path: 'f.txt', fingerprint, selection });
    expect(plan).toMatchObject({ title: 'Discard 1 line in f.txt', destructive: true });
    expect(plan.commands.map((c) => c.args)).toEqual([['apply', '--reverse', '--whitespace=nowarn']]);
    expect(plan.summary).toMatch(/^Take 1 changed line out of f\.txt on disk\. Lanefold builds the patch/);
    expect(plan.notices.map((n) => n.text)).toContain('What is staged of it stays as it is.');
    const result = await ops.execute(plan.id);
    expect(result).toMatchObject({ status: 'done', message: 'Taken out of f.txt on disk.' });
    expect(await read('f.txt')).toBe(EDITED);
    expect(await staged('f.txt')).toBe(EDITED);

    expect((await ops.undo(result.entry!.id)).status).toBe('done');
    expect(Buffer.compare(await bytes('f.txt'), before)).toBe(0);
    expect(ops.undoInfo).toEqual({});
  });

  it('discards lines from both hunks at once, keeping the others', async () => {
    await test.write('f.txt', EDITED);
    const result = await discard('f.txt', {
      lines: [
        await refOf('f.txt', 'unstaged', 'added', 'X'),
        await refOf('f.txt', 'unstaged', 'removed', 'k'),
      ],
    });
    expect(result.status).toBe('done');
    expect(await read('f.txt')).toBe(
      lines('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'K', 'l', 'm'),
    );
    expect(await staged('f.txt')).toBe(BASE);
  });

  it('refuses lines of a diff that changed since it was shown', async () => {
    await test.write('f.txt', EDITED);
    const shown = await request('f.txt', 'unstaged', { hunks: [0] });
    await test.write('f.txt', `${EDITED}more\n`);
    await expect(linePatchFor(repo, shown, false)).rejects.toMatchObject({
      message: 'f.txt changed since it was shown: review it again.',
      code: 'stale',
    });
    expect(await staged('f.txt')).toBe(BASE);

    // A discard: blocked when planned too late, refused when the file changes during the review.
    const blocked = await ops.plan({ kind: 'discardLines', ...shown });
    expect(blocked.blocked).toBe(true);
    expect(blocked.notices.map((n) => n.text)).toContain(
      'f.txt changed since it was shown: review it again.',
    );
    const fresh = await request('f.txt', 'unstaged', { hunks: [0] });
    const plan = await ops.plan({ kind: 'discardLines', ...fresh });
    await test.write('f.txt', EDITED);
    expect(await ops.execute(plan.id)).toMatchObject({ status: 'refused', errorKind: 'stale' });
    expect(await read('f.txt')).toBe(EDITED);
  });

  it('stages part of a new file as a new file with just those lines', async () => {
    await test.write('notes/new.txt', lines('one', 'two', 'three'));
    const diff = toFileHunks(await readFileDiff(repo, 'notes/new.txt', 'untracked'));
    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]!.lines.map((l) => [l.kind, l.newLine])).toEqual([
      ['added', 1],
      ['added', 2],
      ['added', 3],
    ]);
    await stage(
      'notes/new.txt',
      {
        lines: [
          { hunk: 0, line: 0 },
          { hunk: 0, line: 2 },
        ],
      },
      'untracked',
    );
    expect(await staged('notes/new.txt')).toBe(lines('one', 'three'));
    expect(await test.git('status', '--porcelain', '--', 'notes')).toBe('AM notes/new.txt');
    expect(await read('notes/new.txt')).toBe(lines('one', 'two', 'three'));
  });

  it('unstages part of a new file; all of it makes the file untracked again', async () => {
    await test.write('new.txt', lines('one', 'two', 'three'));
    await test.git('add', 'new.txt');
    await unstage('new.txt', { lines: [await refOf('new.txt', 'staged', 'added', 'two')] });
    expect(await staged('new.txt')).toBe(lines('one', 'three'));
    await unstage('new.txt', { hunks: [0] });
    expect(await test.git('status', '--porcelain', '--', 'new.txt')).toBe('?? new.txt');
    expect(await read('new.txt')).toBe(lines('one', 'two', 'three'));
  });

  it('stages and unstages lines before the first commit', async () => {
    const fresh = await TestRepo.create();
    try {
      const unborn = (await Repository.open(fresh.runner, fresh.path))!;
      const act = async (area: DiffArea, selection: LineSelection, reverse: boolean) => {
        const { fingerprint } = await readFileDiff(unborn, 'a.txt', area);
        const patch = await linePatchFor(unborn, { path: 'a.txt', area, fingerprint, selection }, reverse);
        await applyToIndex(unborn, patch, reverse, 'Lines');
      };
      await fresh.write('a.txt', lines('one', 'two', 'three'));
      await act(
        'untracked',
        {
          lines: [
            { hunk: 0, line: 0 },
            { hunk: 0, line: 1 },
          ],
        },
        false,
      );
      expect(await fresh.gitRaw('show', ':a.txt')).toBe(lines('one', 'two'));
      await act('staged', { lines: [{ hunk: 0, line: 0 }] }, true);
      expect(await fresh.gitRaw('show', ':a.txt')).toBe(lines('two'));
    } finally {
      await fresh.dispose();
    }
  });

  it('stages part of a deletion as an edit, and the rest as the deletion', async () => {
    await test.remove('f.txt');
    await stage('f.txt', {
      lines: [
        { hunk: 0, line: 0 },
        { hunk: 0, line: 1 },
      ],
    });
    expect(await staged('f.txt')).toBe(lines('c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'));
    await stage('f.txt', { hunks: [0] });
    expect(await test.git('ls-files', '--', 'f.txt')).toBe('');
    expect(await test.git('status', '--porcelain')).toBe('D  f.txt');
  });

  it('brings back part of a deleted file, staged or on disk', async () => {
    await test.git('rm', '-q', 'f.txt');
    await unstage('f.txt', { lines: [await refOf('f.txt', 'staged', 'removed', 'l')] });
    expect(await staged('f.txt')).toBe(lines('l'));
    await test.git('reset', '-q');
    const result = await discard('f.txt', { lines: [await refOf('f.txt', 'unstaged', 'removed', 'a')] });
    expect(result.status).toBe('done');
    expect(await read('f.txt')).toBe(lines('a'));
  });

  it('handles changes to a last line without a line break', async () => {
    await test.commit('no final break', { files: { 'f.txt': 'x\nold' } });
    await test.write('f.txt', 'x\nnew');
    await stage('f.txt', { lines: [await refOf('f.txt', 'unstaged', 'added', 'new')] });
    expect(await staged('f.txt')).toBe('x\nold\nnew');
    await test.git('reset', '-q');
    await stage('f.txt', { lines: [await refOf('f.txt', 'unstaged', 'removed', 'old')] });
    expect(await staged('f.txt')).toBe('x\n');
    await test.git('reset', '-q');

    // Unstaging the removal alone brings the old line back before the new one.
    await test.git('add', 'f.txt');
    await unstage('f.txt', { lines: [await refOf('f.txt', 'staged', 'removed', 'old')] });
    expect(await staged('f.txt')).toBe('x\nold\nnew');
    await test.git('reset', '-q');

    // Discarding the new line alone leaves the line before it last.
    expect(
      (await discard('f.txt', { lines: [await refOf('f.txt', 'unstaged', 'added', 'new')] })).status,
    ).toBe('done');
    expect(await read('f.txt')).toBe('x\n');
  });

  it('stages adding and removing the final line break, and lines after a last line without one', async () => {
    await test.commit('no final break', { files: { 'f.txt': 'a\nb' } });
    await test.write('f.txt', 'a\nb\n');
    await stage('f.txt', { hunks: [0] });
    expect(await staged('f.txt')).toBe('a\nb\n');
    await test.commit('final break', { files: { 'f.txt': 'a\nb\n' } });
    await test.write('f.txt', 'a\nb');
    await stage('f.txt', { hunks: [0] });
    expect(await staged('f.txt')).toBe('a\nb');
    await test.commit('no final break again', { files: { 'f.txt': 'a\nb' } });
    await test.write('f.txt', 'a\nb\nc\nd');
    await stage('f.txt', { lines: [await refOf('f.txt', 'unstaged', 'added', 'c')] });
    expect(await staged('f.txt')).toBe('a\nb\nc\n');
  });

  it('stages lines at the very start and end of a file, and in files of one line', async () => {
    await test.write('f.txt', `top\n${BASE}bottom\n`);
    await stage('f.txt', { lines: [await refOf('f.txt', 'unstaged', 'added', 'top')] });
    expect(await staged('f.txt')).toBe(`top\n${BASE}`);
    await stage('f.txt', { lines: [await refOf('f.txt', 'unstaged', 'added', 'bottom')] });
    expect(await staged('f.txt')).toBe(`top\n${BASE}bottom\n`);
    await test.commit('one line', { files: { 'one.txt': 'only\n' } });
    await test.write('one.txt', 'changed\n');
    await stage('one.txt', { lines: [await refOf('one.txt', 'unstaged', 'added', 'changed')] });
    expect(await staged('one.txt')).toBe('only\nchanged\n');
  });

  it('keeps CRLF content byte-exact', async () => {
    await test.commit('windows', { files: { 'w.txt': 'a\r\nb\r\nc\r\n' } });
    await test.write('w.txt', 'a\r\nB\r\nc\r\nd\r\n');
    const shown = toFileHunks(await readFileDiff(repo, 'w.txt', 'unstaged'));
    // The carriage returns are not in the text (the line says it has one), but they are kept.
    expect(shown.hunks[0]!.lines.map((l) => [l.text, l.cr])).toEqual([
      ['a', true],
      ['b', true],
      ['B', true],
      ['c', true],
      ['d', true],
    ]);
    await stage('w.txt', { lines: [{ hunk: 0, line: 4 }] });
    expect(
      await test.runner.runBuffer({ cwd: test.path, args: ['show', ':w.txt'] }).then((r) => r.stdout),
    ).toEqual(Buffer.from('a\r\nb\r\nc\r\nd\r\n'));
    const before = await bytes('w.txt');
    const result = await discard('w.txt', {
      lines: [
        { hunk: 0, line: 1 },
        { hunk: 0, line: 2 },
      ],
    });
    expect(await bytes('w.txt')).toEqual(Buffer.from('a\r\nb\r\nc\r\nd\r\n'));
    await ops.undo(result.entry!.id);
    expect(await bytes('w.txt')).toEqual(before);
  });

  it('acts on exactly the named file, whatever characters its name has', async () => {
    const names = ['my file.txt', 'naïve ☃.txt', '[draft].md', '-dash.txt'];
    // Names Windows does not allow.
    if (process.platform !== 'win32') names.push('*.md', 'tab\there.txt', 'quote"d.txt');
    await test.commit('names', {
      files: Object.fromEntries([...names, 'd.md', 'x.md'].map((name) => [name, BASE])),
    });
    for (const name of [...names, 'd.md', 'x.md']) await test.write(name, EDITED);
    for (const name of names) {
      await stage(name, { lines: [await refOf(name, 'unstaged', 'added', 'm')] });
      expect(await staged(name)).toBe(`${BASE}m\n`);
    }
    // Patterns name themselves only.
    expect(await staged('d.md')).toBe(BASE);
    expect(await staged('x.md')).toBe(BASE);
    await test.write('[new].txt', lines('one', 'two'));
    await test.write('n.txt', lines('decoy'));
    await stage('[new].txt', { lines: [{ hunk: 0, line: 1 }] }, 'untracked');
    expect(await staged('[new].txt')).toBe(lines('two'));
    expect(await test.git('ls-files', '--', 'n.txt')).toBe('');
    // Discarding and Undo work with such names too.
    const result = await discard('naïve ☃.txt', {
      lines: [await refOf('naïve ☃.txt', 'unstaged', 'added', 'X')],
    });
    expect(await read('naïve ☃.txt')).toBe(
      lines('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K', 'l', 'm'),
    );
    await ops.undo(result.entry!.id);
    expect(await read('naïve ☃.txt')).toBe(EDITED);
  });

  it('only offers whole-file actions for binary, renamed, mode-changed, linked and very large files', async () => {
    await test.commit('more', { files: { 'bin.dat': 'a\0b', 'old.txt': BASE, 'run.sh': 'echo\n' } });
    await test.write('bin.dat', 'a\0c');
    expect(await readFileDiff(repo, 'bin.dat', 'unstaged')).toMatchObject({ wholeFile: 'binary' });
    await test.git('mv', 'old.txt', 'renamed.txt');
    await test.write('renamed.txt', EDITED);
    await test.git('add', 'renamed.txt');
    const renamed = toFileHunks(await readFileDiff(repo, 'renamed.txt', 'staged'));
    expect(renamed).toMatchObject({ wholeFile: 'renamed', renamedFrom: 'old.txt' });
    expect(renamed.hunks).toHaveLength(2);
    // Windows has neither executable bits nor (without privileges) symbolic links.
    if (process.platform !== 'win32') {
      await chmod(join(test.path, 'run.sh'), 0o755);
      expect(toFileHunks(await readFileDiff(repo, 'run.sh', 'unstaged'))).toMatchObject({
        wholeFile: 'modeChange',
        modes: { from: '100644', to: '100755' },
      });
      await symlink('f.txt', join(test.path, 'link'));
      expect(await readFileDiff(repo, 'link', 'untracked')).toMatchObject({ wholeFile: 'symlink' });
    }
    // A repository inside the working tree is listed as one entry ("nested/").
    await test.write('nested/inner.txt', 'inner\n');
    await test.git('-C', 'nested', 'init', '-q');
    expect(await readFileDiff(repo, 'nested/', 'untracked')).toMatchObject({ wholeFile: 'submodule' });
    await test.write('big.txt', lines(...Array.from({ length: 3001 }, (_, i) => `line ${i}`)));
    expect(await readFileDiff(repo, 'big.txt', 'untracked')).toMatchObject({ wholeFile: 'tooLarge' });
    await test.git('add', 'big.txt');
    expect(await readFileDiff(repo, 'big.txt', 'staged')).toMatchObject({
      wholeFile: 'tooLarge',
      additions: 3001,
    });
    const refusal = /only the whole file can be staged, unstaged or discarded/;
    await expect(
      linePatchFor(repo, await request('bin.dat', 'unstaged', { hunks: [0] }), false),
    ).rejects.toThrow(refusal);
    await expect(
      linePatchFor(repo, await request('renamed.txt', 'staged', { hunks: [0] }), true),
    ).rejects.toThrow(refusal);
    await expect(
      linePatchFor(repo, await request('big.txt', 'staged', { hunks: [0] }), true),
    ).rejects.toThrow(refusal);
  });

  it('reads only files git lists in that area', async () => {
    await test.write('.gitignore', 'ignored.txt\n');
    await test.write('ignored.txt', 'secret\n');
    await test.write('f.txt', EDITED);
    await expect(readFileDiff(repo, 'ignored.txt', 'untracked')).rejects.toThrow(/not a new file/);
    await expect(readFileDiff(repo, 'f.txt', 'untracked')).rejects.toThrow(/not a new file/);
    await expect(readFileDiff(repo, '../outside.txt', 'untracked')).rejects.toThrow();
    await expect(readFileDiff(repo, '.', 'untracked')).rejects.toThrow();
    await test.write('dir/one.txt', 'one\n');
    await test.git('add', 'dir');
    await test.write('dir/one.txt', 'one!\n');
    await test.write('dir/two.txt', 'two\n');
    await test.git('add', 'dir/two.txt');
    await test.write('dir/two.txt', 'two!\n');
    await expect(readFileDiff(repo, 'dir', 'unstaged')).rejects.toThrow(/not a file/);
    // No changes there: nothing to show.
    expect(toFileHunks(await readFileDiff(repo, 'f.txt', 'staged'))).toMatchObject({
      hunks: [],
      additions: 0,
    });
    // An empty new file has no hunks either: it says it is new (or deleted).
    await test.write('empty.txt', '');
    await test.git('add', 'empty.txt');
    expect(toFileHunks(await readFileDiff(repo, 'empty.txt', 'staged'))).toMatchObject({
      hunks: [],
      created: true,
    });
    await test.commit('empty', { files: { 'empty.txt': '' } });
    await test.git('rm', '-q', 'empty.txt');
    expect(toFileHunks(await readFileDiff(repo, 'empty.txt', 'staged'))).toMatchObject({
      hunks: [],
      deleted: true,
    });
  });

  it('agrees with a line-by-line model of staging, unstaging and discarding (random edits)', async () => {
    const random = mulberry32(20261013);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
    const words = ['alpha', 'beta', 'gamma', 'delta', '', '}', 'return x;'];
    const file = (texts: string[], eol: boolean) =>
      texts.length === 0 ? '' : texts.join('\n') + (eol ? '\n' : '');
    for (let round = 0; round < 24; round++) {
      const old = Array.from({ length: Math.floor(random() * 14) }, () => pick(words));
      const changed = [...old];
      for (let edit = Math.floor(random() * 5) + 1; edit > 0; edit--) {
        const at = Math.floor(random() * (changed.length + 1));
        const what = random();
        if (what < 0.4) changed.splice(at, 0, `new ${round}.${edit}`);
        else if (what < 0.7 && changed.length > 0) changed.splice(Math.min(at, changed.length - 1), 1);
        else if (changed.length > 0) changed[Math.min(at, changed.length - 1)] = `edit ${round}.${edit}`;
      }
      const oldText = file(old, old.length === 0 || random() < 0.7);
      const newText = file(changed, changed.length === 0 || random() < 0.7);
      if (oldText === newText) continue;
      const mode = pick(['stage', 'unstage', 'discard'] as const);
      await test.commit(`round ${round}`, { files: { 'r.txt': oldText }, allowEmpty: true });
      await test.write('r.txt', newText);
      if (mode === 'unstage') await test.git('add', 'r.txt');
      const area: DiffArea = mode === 'unstage' ? 'staged' : 'unstaged';
      const diff = await readFileDiff(repo, 'r.txt', area);
      const changes = diff.patch!.hunks.flatMap((hunk, h) =>
        hunk.lines.flatMap((line, l) => (line.kind === ' ' ? [] : [{ hunk: h, line: l }])),
      );
      const chosen = changes.filter(() => random() < 0.5);
      if (chosen.length === 0) chosen.push(pick(changes));
      const selection = { lines: chosen };
      const reverse = mode !== 'stage';
      const patch = await linePatchFor(
        repo,
        { path: 'r.txt', area, fingerprint: diff.fingerprint, selection },
        reverse,
      );
      const expected = modelResult(oldText, newText, diff.patch!, selection, reverse);
      const context = `round ${round} (${mode}): ${JSON.stringify(oldText)} → ${JSON.stringify(newText)}, ${JSON.stringify(chosen)}\n${patch.text}`;
      if (mode === 'discard') {
        await repo.git(['apply', '--reverse', '--whitespace=nowarn'], { stdin: patchBytes(patch) });
        expect(await read('r.txt'), context).toBe(expected);
      } else {
        await applyToIndex(repo, patch, reverse, mode);
        expect(await staged('r.txt'), context).toBe(expected);
      }
      await test.git('reset', '-q', '--hard');
    }
  });
});

/**
 * What a partial patch should produce, computed line by line: forward, the old file with the
 * selected changes made; in reverse, the new file with them taken back. A line keeps the line
 * break it had where it came from, except that only the file's last line can lack one.
 */
function modelResult(
  oldText: string,
  newText: string,
  patch: NonNullable<Awaited<ReturnType<typeof readFileDiff>>['patch']>,
  selection: { lines: readonly LineRef[] },
  reverse: boolean,
): string {
  const split = (text: string) => {
    const parts = text.split('\n');
    const eol = parts.at(-1) === '';
    if (eol) parts.pop();
    return parts.map((t, i) => ({ text: t, eol: eol || i < parts.length - 1 }));
  };
  const before = split(oldText);
  const after = split(newText);
  const base = reverse ? after : before;
  const chosen = new Set(selection.lines.map((ref) => `${ref.hunk}:${ref.line}`));
  const result: { text: string; eol: boolean }[] = [];
  let next = 1; // next line of `base` (1-based) not copied yet
  for (const [h, hunk] of patch.hunks.entries()) {
    const start = reverse ? hunk.newStart : hunk.oldStart;
    const count = reverse ? hunk.newCount : hunk.oldCount;
    const first = count > 0 ? start : start + 1;
    while (next < first) result.push(base[next++ - 1]!);
    for (const [l, line] of hunk.lines.entries()) {
      const selected = chosen.has(`${h}:${l}`);
      const own = line.kind === ' ' ? 'both' : line.kind === '+' ? 'after' : 'before';
      const source = own === 'after' || (own === 'both' && reverse) ? after : before;
      const number = own === 'after' || (own === 'both' && reverse) ? line.newLine! : line.oldLine!;
      const keep =
        own === 'both' ||
        (reverse ? (own === 'after' ? !selected : selected) : own === 'before' ? !selected : selected);
      if (keep) result.push(source[number - 1]!);
      if (own === 'both' || own === (reverse ? 'after' : 'before')) next++;
    }
  }
  while (next <= base.length) result.push(base[next++ - 1]!);
  return result.map((line, i) => line.text + (line.eol || i < result.length - 1 ? '\n' : '')).join('');
}

/** A small seeded random number generator (deterministic test data). */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A webview as the backend sees it: calls methods, collects events. */
class View implements RpcTransport {
  readonly events: { event: string; payload: unknown }[] = [];
  private handler: ((message: RpcMessage) => void) | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();

  send(message: RpcMessage): void {
    if (message.kind === 'evt') this.events.push({ event: message.event, payload: message.payload });
    else if (message.kind === 'res') this.pending.get(message.id)?.(message);
  }

  onMessage(handler: (message: RpcMessage) => void): () => void {
    this.handler = handler;
    return () => (this.handler = undefined);
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.kind !== 'res') return;
        if (message.ok) resolve(message.result as T);
        else reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      });
      this.handler?.({ kind: 'req', id, method, params });
    });
  }
}

describe('line staging through the backend (real git)', () => {
  let test: TestRepo;
  let backend: Backend;
  let view: View;
  let repoId: string;

  beforeEach(async () => {
    test = await TestRepo.create();
    await test.commit('base', { files: { 'f.txt': BASE } });
    const registry = new RepositoryRegistry();
    backend = new Backend({ platform: new HarnessPlatform(), registry, console: new ConsoleLog() });
    backend.setGit(test.runner);
    registry.add((await Repository.open(test.runner, test.path))!);
    view = new View();
    backend.connect(view);
    repoId = (await view.call<{ repos: { id: string }[] }>('app.init', {})).repos[0]!.id;
  });

  afterEach(async () => {
    backend.dispose();
    await test.dispose();
  });

  const hunks = (path: string, area: DiffArea) => view.call<FileHunks>('diff.hunks', { repoId, path, area });

  it('shows a file’s hunks and stages and unstages lines named by position', async () => {
    await test.write('f.txt', EDITED);
    const shown = await hunks('f.txt', 'unstaged');
    expect(shown).toMatchObject({ path: 'f.txt', area: 'unstaged', additions: 4, deletions: 2 });
    expect(shown.hunks[1]).toMatchObject({ oldStart: 8, newStart: 9, section: 'g' });
    expect(shown.hunks[0]!.lines[2]).toEqual({ kind: 'added', text: 'B', newLine: 2 });
    await view.call('index.stageLines', {
      repoId,
      path: 'f.txt',
      area: 'unstaged',
      fingerprint: shown.fingerprint,
      selection: { lines: [{ hunk: 0, line: 4 }] },
    });
    expect(await test.gitRaw('show', ':f.txt')).toBe(
      lines('a', 'b', 'c', 'X', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'),
    );
    expect(view.events.some((e) => e.event === 'repo.changed')).toBe(true);
    const stagedHunks = await hunks('f.txt', 'staged');
    await view.call('index.unstageLines', {
      repoId,
      path: 'f.txt',
      area: 'staged',
      fingerprint: stagedHunks.fingerprint,
      selection: { hunks: [0] },
    });
    expect(await test.gitRaw('show', ':f.txt')).toBe(BASE);
  });

  it('refuses requests it cannot trust', async () => {
    await test.write('f.txt', EDITED);
    const { fingerprint } = await hunks('f.txt', 'unstaged');
    const stage = (params: Record<string, unknown>) =>
      view.call('index.stageLines', {
        repoId,
        path: 'f.txt',
        area: 'unstaged',
        fingerprint,
        selection: { hunks: [0] },
        ...params,
      });
    await expect(hunks('/etc/passwd', 'untracked')).rejects.toThrow(/Not a file path/);
    await expect(hunks('f.txt', 'everything' as DiffArea)).rejects.toThrow(/Not a diff area/);
    await expect(stage({ area: 'staged' })).rejects.toThrow(/Not a diff area/);
    await expect(stage({ path: '' })).rejects.toThrow(/Not a file path/);
    await expect(stage({ fingerprint: 'not hex' })).rejects.toThrow(/review it again/);
    await expect(stage({ selection: { hunks: ['0'] } })).rejects.toThrow(/Choose the lines/);
    await expect(stage({ selection: { lines: [{ hunk: 0, line: 0 }] } })).rejects.toThrow(/added or removed/);
    await expect(stage({ selection: { hunks: [7] } })).rejects.toThrow(/no hunk 8/);
    await expect(stage({ fingerprint: '0'.repeat(64) })).rejects.toMatchObject({ code: 'stale' });
    await expect(
      view.call('index.unstageLines', {
        repoId,
        path: 'f.txt',
        area: 'unstaged',
        fingerprint,
        selection: {},
      }),
    ).rejects.toThrow(/Not a diff area/);
    expect(await test.gitRaw('show', ':f.txt')).toBe(BASE);
  });

  it('keeps a snapshot before unstaging lines that were edited again since', async () => {
    await test.write('f.txt', EDITED);
    await test.git('add', 'f.txt');
    await test.write('f.txt', `${EDITED}more\n`);
    const backups = async () =>
      (await test.git('reflog', 'show', '--format=%gs', 'refs/lanefold/backup').catch(() => ''))
        .split('\n')
        .filter(Boolean).length;
    expect(await backups()).toBe(0);
    const { fingerprint } = await hunks('f.txt', 'staged');
    await view.call('index.unstageLines', {
      repoId,
      path: 'f.txt',
      area: 'staged',
      fingerprint,
      selection: { hunks: [1] },
    });
    expect(await backups()).toBe(1);
    expect(await test.gitRaw('show', ':f.txt')).toBe(
      lines('a', 'B', 'c', 'X', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'),
    );
  });
});
