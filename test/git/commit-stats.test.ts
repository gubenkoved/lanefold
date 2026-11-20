import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RepoData } from '../../src/core/repo/repoData';
import { Repository } from '../../src/core/repo/repository';
import { TestRepo } from '../fixtures/repoBuilder';

describe('what commits changed, for the graph’s Files and Lines columns (real git)', () => {
  let test: TestRepo;
  let data: RepoData;
  let root: string;
  let edit: string;
  let rename: string;
  let binary: string;
  let empty: string;
  let merge: string;
  /** A file named like a commit, with lines of its own. */
  const hexName = 'c'.repeat(40);

  beforeAll(async () => {
    test = await TestRepo.create();
    root = await test.commit('root', {
      files: { 'a.txt': 'a1\na2\na3\n', 'b.txt': 'b1\n', 'old-name.txt': 'one\ntwo\nthree\nfour\n' },
    });
    // One file edited, one removed, one added.
    edit = await test.commit('edit', {
      files: { 'a.txt': 'a1\nA2\na3\na4\n', 'b.txt': null, [hexName]: 'x\ny\n' },
    });
    await test.git('mv', 'old-name.txt', 'new-name.txt');
    rename = await test.commit('rename', { files: { 'a.txt': 'a1\nA2\na3\na4\na5\n' } });
    await writeFile(join(test.path, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255, 254, 0, 3]));
    await test.git('add', '--', 'logo.bin');
    binary = await test.commit('binary', { files: { 'c.txt': 'c1\n' } });
    empty = await test.commit('empty', { files: {}, allowEmpty: true });
    await test.checkoutNew('side', root);
    await test.commit('side work', { files: { 'side.txt': 's1\ns2\n' } });
    await test.checkout('main');
    merge = await test.merge('side', { noFF: true, message: 'Merge side' });
    data = new RepoData((await Repository.open(test.runner, test.path))!);
  });

  afterAll(async () => {
    data.dispose();
    await test.dispose();
  });

  it('counts files added, changed and removed without reading their lines', async () => {
    const stats = await data.commitStats([edit, root, rename, empty], false);
    expect(stats).toEqual([
      { sha: edit, added: 1, modified: 1, removed: 1 },
      // A root commit: against nothing.
      { sha: root, added: 3, modified: 0, removed: 0 },
      // A rename is one file changed in place, not one added and one removed.
      { sha: rename, added: 0, modified: 2, removed: 0 },
      { sha: empty, added: 0, modified: 0, removed: 0 },
    ]);
  });

  it('counts lines when asked to, binary files apart', async () => {
    const stats = await data.commitStats([edit, rename, binary, empty], true);
    expect(stats).toEqual([
      { sha: edit, added: 1, modified: 1, removed: 1, lines: { added: 4, removed: 2, binary: 0 } },
      { sha: rename, added: 0, modified: 2, removed: 0, lines: { added: 1, removed: 0, binary: 0 } },
      { sha: binary, added: 2, modified: 0, removed: 0, lines: { added: 1, removed: 0, binary: 1 } },
      { sha: empty, added: 0, modified: 0, removed: 0, lines: { added: 0, removed: 0, binary: 0 } },
    ]);
  });

  it('counts a merge against its first parent, as its file list does', async () => {
    const [stats] = await data.commitStats([merge], true);
    const details = await data.commitDetails(merge);
    expect(details.files.map((file) => file.path)).toEqual(['side.txt']);
    expect(stats).toEqual({
      sha: merge,
      added: 1,
      modified: 0,
      removed: 0,
      lines: { added: 2, removed: 0, binary: 0 },
    });
  });

  it('agrees with the file list of every commit', async () => {
    const shas = [root, edit, rename, binary, empty, merge];
    const stats = await data.commitStats(shas, true);
    for (const [index, sha] of shas.entries()) {
      const { files } = await data.commitDetails(sha);
      const sum = (pick: (file: (typeof files)[number]) => number) =>
        files.reduce((total, file) => total + pick(file), 0);
      expect(stats[index]).toMatchObject({
        sha,
        added: files.filter((file) => file.status === 'A').length,
        removed: files.filter((file) => file.status === 'D').length,
        lines: { added: sum((file) => file.additions), removed: sum((file) => file.deletions) },
      });
      expect(stats[index]!.added + stats[index]!.modified + stats[index]!.removed).toBe(files.length);
    }
  });

  it('leaves out commits the repository does not have, and reads the others', async () => {
    const fresh = new RepoData((await Repository.open(test.runner, test.path))!);
    try {
      const stats = await fresh.commitStats(['f'.repeat(40), edit, 'e'.repeat(40), root], false);
      expect(stats.map((entry) => entry.sha)).toEqual([edit, root]);
    } finally {
      fresh.dispose();
    }
  });

  it('remembers what it read: lines once read answer for files too', async () => {
    const commands: string[] = [];
    const counted = await TestRepo.create({
      runnerOptions: { listener: { onCommandStart: (start) => commands.push(start.args.join(' ')) } },
    });
    const sha = await counted.commit('only', { files: { 'a.txt': 'a\n' } });
    const counting = new RepoData((await Repository.open(counted.runner, counted.path))!);
    try {
      commands.length = 0;
      const reads = () => commands.filter((command) => command.startsWith('diff-tree')).length;
      await counting.commitStats([sha], false);
      await counting.commitStats([sha], false);
      expect(reads()).toBe(1);
      // Lines were not read yet: one more read, which then serves both.
      await counting.commitStats([sha], true);
      await counting.commitStats([sha], true);
      await counting.commitStats([sha], false);
      expect(reads()).toBe(2);
    } finally {
      counting.dispose();
      await counted.dispose();
    }
  });

  it('stops when the request is cancelled', async () => {
    const fresh = new RepoData((await Repository.open(test.runner, test.path))!);
    const controller = new AbortController();
    controller.abort();
    await expect(fresh.commitStats([root], true, controller.signal)).rejects.toMatchObject({
      kind: 'cancelled',
    });
    fresh.dispose();
  });
});
