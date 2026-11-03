import { describe, expect, it } from 'vitest';
import {
  annotationTexts,
  authorLabel,
  blameBlocks,
  dateLabel,
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

describe('blame annotations', () => {
  it('name authors in the style asked for', () => {
    const name = (style: Parameters<typeof authorLabel>[2]) =>
      authorLabel('Maneeshi  Kumari Sharma', 'msharma@example.com', style);
    expect(name('full')).toBe('Maneeshi Kumari Sharma');
    expect(name('first')).toBe('Maneeshi');
    expect(name('firstInitial')).toBe('Maneeshi S.');
    expect(name('initialLast')).toBe('M. Sharma');
    expect(name('initials')).toBe('MS');
    expect(name('email')).toBe('msharma');
    expect(name('none')).toBe('');
    // One word, another script, no name at all.
    expect(authorLabel('Cher', 'cher@example.com', 'initialLast')).toBe('Cher');
    expect(authorLabel('Ёжик туманов', 'e@example.com', 'initials')).toBe('ЁТ');
    expect(authorLabel('', 'bot@ci.example', 'firstInitial')).toBe('bot');
  });

  it('date changes in the style asked for', () => {
    const now = Date.UTC(2026, 10, 3, 12);
    const time = Date.UTC(2017, 2, 16, 12) / 1000;
    expect(dateLabel(time, 'iso', now)).toBe('2017-03-16');
    expect(dateLabel(time, 'date', now)).toMatch(/2017/);
    expect(dateLabel(time, 'relative', now)).toMatch(/9 years ago/);
    expect(dateLabel(now / 1000 - 3 * 86_400, 'auto', now)).toBe('3d ago');
    expect(dateLabel(time, 'none', now)).toBe('');
  });

  it('line the authors up after the longest date, and leave out what is not wanted', () => {
    const { commits } = parseBlamePorcelain(PORCELAIN);
    const now = 1_700_000_400 * 1000;
    const texts = annotationTexts(commits, { author: 'first', date: 'auto' }, now);
    // "uncommitted" is the longest date: every name starts one place after it.
    expect(texts.get(Z)).toBe('uncommitted\u00a0you');
    expect(texts.get(A)).toBe(`6m ago${'\u00a0'.repeat(6)}Alice`);
    expect(texts.get(B)).toBe(`3m ago${'\u00a0'.repeat(6)}Bob`);
    expect(annotationTexts(commits, { author: 'none', date: 'iso' }, now).get(B)).toMatch(/^2023-11-1\d$/);
    expect(annotationTexts(commits, { author: 'initials', date: 'none' }, now).get(A)).toBe('AA');
  });
});
