import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blameFile, commitMessage, diffWithContents, previousLine } from '../../src/core/blame/blame';
import { mapLineToOld, parseHunks } from '../../src/shared/blame';
import { Repository } from '../../src/core/repo/repository';
import { ALICE, BOB, TestRepo } from '../fixtures/repoBuilder';

describe('blame (real git)', () => {
  let test: TestRepo;
  let repo: Repository;
  let one: string;
  let two: string;

  beforeEach(async () => {
    test = await TestRepo.create();
    one = await test.commit('Add the file', { files: { 'f.txt': '1\n2\n3\n4\n5\n' }, author: ALICE });
    two = await test.commit('Rework line three\n\nWith a body.', {
      files: { 'f.txt': '1\n2\nthree\n3b\n4\n5\n' },
      author: BOB,
    });
    await test.git('mv', 'f.txt', 'g.txt');
    await test.commit('Rename', { files: {} });
    repo = (await Repository.open(test.runner, test.path))!;
  });

  afterEach(async () => {
    await test.dispose();
  });

  it('attributes every line and follows the rename', async () => {
    const result = await blameFile(repo, 'g.txt');
    expect(result.lines.map((line) => line.sha)).toEqual([one, one, two, two, one, one]);
    const commit = result.commits.get(two)!;
    expect(commit).toMatchObject({ author: BOB.name, summary: 'Rework line three', filename: 'f.txt' });
    expect(commit.previous).toEqual({ sha: one, path: 'f.txt' });
    expect(result.lines[5]).toEqual({ sha: one, origLine: 5 });
  });

  it('blames unsaved contents on top of HEAD', async () => {
    const result = await blameFile(repo, 'g.txt', { contents: 'zero\n1\n2\nthree\n3b\n4\n5\n' });
    const first = result.commits.get(result.lines[0]!.sha)!;
    expect(first.uncommitted).toBe(true);
    expect(result.lines.slice(1).map((line) => line.sha)).toEqual([one, one, two, two, one, one]);
  });

  it('blames a revision and maps a changed line to the version before it', async () => {
    const result = await blameFile(repo, 'g.txt', { rev: 'HEAD' });
    const line = result.lines[3]!; // "3b", added by `two`
    const commit = result.commits.get(line.sha)!;
    expect(await previousLine(repo, commit, line.origLine)).toEqual({ sha: one, path: 'f.txt', line: 3 });
    const five = result.lines[5]!; // unchanged "5": blamed to `one`, which has no previous
    expect(await previousLine(repo, result.commits.get(five.sha)!, five.origLine)).toBeUndefined();
    expect(await commitMessage(repo, two)).toBe('Rework line three\n\nWith a body.');
  });

  it('maps an uncommitted line against HEAD', async () => {
    await test.write('g.txt', '1\n2\nthree\nchanged\n4\n5\n');
    const result = await blameFile(repo, 'g.txt');
    const line = result.lines[3]!;
    const commit = result.commits.get(line.sha)!;
    expect(commit.uncommitted).toBe(true);
    const head = await test.rev('HEAD');
    expect(await previousLine(repo, commit, line.origLine, 'g.txt')).toEqual({
      sha: head,
      path: 'g.txt',
      line: 4,
    });
  });

  it('maps lines of unsaved contents, not of the file on disk', async () => {
    // Two lines typed above and line three changed, none of it saved.
    const unsaved = 'new a\nnew b\n1\n2\nTHREE\n3b\n4\n5\n';
    const diff = await diffWithContents(repo, 'HEAD:g.txt', unsaved);
    expect(mapLineToOld(parseHunks(diff), 6)).toBe(4);
    const result = await blameFile(repo, 'g.txt', { contents: unsaved });
    const line = result.lines[4]!;
    const commit = result.commits.get(line.sha)!;
    expect(commit.uncommitted).toBe(true);
    // Line 5 of the editor replaced line 3 of HEAD (the file on disk has no such shift).
    const previous = await previousLine(repo, commit, line.origLine, 'g.txt', unsaved);
    expect(previous?.line).toBe(3);
  });
});
