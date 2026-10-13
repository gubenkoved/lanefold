import { describe, expect, it } from 'vitest';
import {
  blameBlocks,
  mapLineToOld,
  parseBlamePorcelain,
  parseHunks,
  unquotePath,
} from '../../src/shared/blame';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

const PORCELAIN = [
  `${Z} 1 1 1`,
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 1700000300',
  'author-tz +0000',
  'committer Not Committed Yet',
  'committer-mail <not.committed.yet>',
  'committer-time 1700000300',
  'committer-tz +0000',
  'summary Version of g.txt from g.txt',
  `previous ${B} g.txt`,
  'filename g.txt',
  '\tzero',
  `${A} 1 2 2`,
  'author Alice Archer',
  'author-mail <alice@example.com>',
  'author-time 1700000000',
  'author-tz +0100',
  'committer Bob',
  'committer-mail <bob@example.com>',
  'committer-time 1700000100',
  'committer-tz +0000',
  'summary First',
  'boundary',
  'filename "old\\tname.txt"',
  '\t1',
  `${A} 2 3`,
  '\t2',
  `${B} 3 4 1`,
  'author Bob',
  'author-mail <bob@example.com>',
  'author-time 1700000200',
  'author-tz +0000',
  'committer Bob',
  'committer-mail <bob@example.com>',
  'committer-time 1700000200',
  'committer-tz +0000',
  'summary Second',
  `previous ${A} "old\\tname.txt"`,
  'filename g.txt',
  '\tthree',
  '',
].join('\n');

describe('blame', () => {
  it('parses porcelain output, including uncommitted lines and quoted paths', () => {
    const result = parseBlamePorcelain(PORCELAIN);
    expect(result.lines).toEqual([
      { sha: Z, origLine: 1 },
      { sha: A, origLine: 1 },
      { sha: A, origLine: 2 },
      { sha: B, origLine: 3 },
    ]);
    expect(result.commits.get(A)).toMatchObject({
      author: 'Alice Archer',
      authorMail: 'alice@example.com',
      authorTime: 1700000000,
      authorTz: '+0100',
      summary: 'First',
      boundary: true,
      filename: 'old\tname.txt',
      uncommitted: false,
    });
    expect(result.commits.get(B)!.previous).toEqual({ sha: A, path: 'old\tname.txt' });
    expect(result.commits.get(Z)).toMatchObject({ uncommitted: true, previous: { sha: B, path: 'g.txt' } });
    expect(blameBlocks(result)).toEqual([
      { start: 0, length: 1, sha: Z },
      { start: 1, length: 2, sha: A },
      { start: 3, length: 1, sha: B },
    ]);
  });

  it('unquotes git paths with octal UTF-8 escapes', () => {
    expect(unquotePath('"caf\\303\\251.txt"')).toBe('café.txt');
    expect(unquotePath('"a\\"b"')).toBe('a"b');
    expect(unquotePath('plain.txt')).toBe('plain.txt');
  });

  it('maps lines of a new version back to the old one', () => {
    // old: 1 2 3 4 5 6 7     new: 1 2 X Y 4 5 7 8
    // line 3 replaced by X, Y; line 6 deleted; line 8 appended.
    const hunks = parseHunks(
      ['@@ -3 +3,2 @@', '-3', '+X', '+Y', '@@ -6 +6,0 @@', '-6', '@@ -7,0 +8 @@', '+8'].join('\n'),
    );
    expect(hunks).toEqual([
      { oldStart: 3, oldCount: 1, newStart: 3, newCount: 2 },
      { oldStart: 6, oldCount: 1, newStart: 6, newCount: 0 },
      { oldStart: 7, oldCount: 0, newStart: 8, newCount: 1 },
    ]);
    const map = (line: number) => mapLineToOld(hunks, line);
    expect([1, 2].map(map)).toEqual([1, 2]); // unchanged before
    expect([3, 4].map(map)).toEqual([3, 3]); // the replacement maps onto what it replaced
    expect([5, 6].map(map)).toEqual([4, 5]); // shifted by the extra line
    expect(map(7)).toBe(7); // after the deletion
    expect(map(8)).toBe(7); // appended: the line before it
  });

  it('maps a line inserted at the very top to the first line', () => {
    expect(mapLineToOld(parseHunks('@@ -0,0 +1 @@\n+new'), 1)).toBe(1);
    expect(mapLineToOld(parseHunks('@@ -0,0 +1 @@\n+new'), 2)).toBe(1);
    expect(mapLineToOld([], 40, 10)).toBe(10);
  });
});
