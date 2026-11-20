import { describe, expect, it } from 'vitest';
import { compactCount, filesChangedText, initials, linesChangedText } from '../../src/webview/graph/format';

describe('initials', () => {
  it('takes the first and last word', () => {
    expect(initials('Carol Chen')).toBe('CC');
    expect(initials('Alice B. Archer')).toBe('AA');
    expect(initials('madonna')).toBe('M');
  });

  it('takes whole characters, from words that start with a letter or digit', () => {
    expect(initials('Zoë Ångström 🚀')).toBe('ZÅ');
    expect(initials('山田 太郎')).toBe('山太');
    expect(initials('🚀 rocket')).toBe('R');
    expect(initials('🚀')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});

describe('compactCount', () => {
  it('leaves counts below a thousand as they are', () => {
    expect([0, 1, 42, 999].map(compactCount)).toEqual(['0', '1', '42', '999']);
  });

  it('counts in thousands, with a decimal while it fits in four characters', () => {
    expect([1000, 1432, 1950, 9949].map(compactCount)).toEqual(['1K', '1.4K', '1.9K', '9.9K']);
    expect([9950, 12_400, 48_210, 412_300, 999_499].map(compactCount)).toEqual([
      '10K',
      '12K',
      '48K',
      '412K',
      '999K',
    ]);
  });

  it('counts in millions, and takes the next unit instead of "1000K"', () => {
    expect([999_500, 999_700, 1_512_400, 2_304_118, 9_949_999].map(compactCount)).toEqual([
      '1M',
      '1M',
      '1.5M',
      '2.3M',
      '9.9M',
    ]);
    expect([9_950_000, 14_230_000, 999_499_999].map(compactCount)).toEqual(['10M', '14M', '999M']);
    expect([999_500_000, 2_500_000_000].map(compactCount)).toEqual(['1B', '2.5B']);
  });

  it('never takes more than four characters, up to a billion', () => {
    for (let count = 1; count < 2_000_000_000; count = Math.ceil(count * 1.07))
      expect(compactCount(count).length).toBeLessThanOrEqual(4);
  });
});

describe('exact counts in words', () => {
  const stats = (added: number, modified: number, removed: number) => ({
    sha: 'a'.repeat(40),
    added,
    modified,
    removed,
  });

  it('says how many files, and of which kind', () => {
    expect(filesChangedText(stats(2, 6, 1))).toBe('9 files: 2 added, 6 changed, 1 removed');
    expect(filesChangedText(stats(0, 1, 0))).toBe('1 file: 1 changed');
    expect(filesChangedText(stats(14_230, 0, 0))).toBe('14,230 files: 14,230 added');
    expect(filesChangedText(stats(0, 0, 0))).toBe('No files changed');
  });

  it('says how many lines, and which files have none to count', () => {
    expect(linesChangedText({ added: 184, removed: 23, binary: 0 })).toBe('184 lines added, 23 removed');
    expect(linesChangedText({ added: 1, removed: 0, binary: 0 })).toBe('1 line added');
    expect(linesChangedText({ added: 0, removed: 2_304_118, binary: 0 })).toBe('2,304,118 lines removed');
    expect(linesChangedText({ added: 3, removed: 0, binary: 2 })).toBe(
      '3 lines added; 2 binary files not counted',
    );
    expect(linesChangedText({ added: 0, removed: 0, binary: 1 })).toBe('1 binary file not counted');
    expect(linesChangedText({ added: 0, removed: 0, binary: 0 })).toBe('No lines changed');
  });

  it('says what a merge is compared with', () => {
    expect(filesChangedText(stats(1, 0, 0), true)).toBe('1 file: 1 added (against the first parent)');
    expect(filesChangedText(stats(0, 0, 0), true)).toBe('No files changed (against the first parent)');
    expect(linesChangedText({ added: 2, removed: 0, binary: 0 }, true)).toBe(
      '2 lines added (against the first parent)',
    );
  });
});
