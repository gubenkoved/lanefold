import { describe, expect, it } from 'vitest';
import { checkCount, checkFilePaths, checkOneOf, checkRev } from '../../src/core/backend/params';
import { validJournal } from '../../src/core/ops/journal';

const SHA = 'a'.repeat(40);

describe('request checks', () => {
  it('clamps counts and rejects what is not a number', () => {
    expect(checkCount(undefined, 5000, 500)).toBe(500);
    expect(checkCount(12.7, 5000)).toBe(12);
    expect(checkCount(0, 5000)).toBe(1);
    expect(checkCount(1e9, 5000)).toBe(5000);
    expect(checkCount(Infinity, 5000)).toBe(5000);
    expect(() => checkCount('5', 5000)).toThrow('Not a count');
    expect(() => checkCount(Number.NaN, 5000)).toThrow('Not a count');
  });

  it('takes revisions that git never reads as options', () => {
    expect(checkRev('main...feature')).toBe('main...feature');
    expect(() => checkRev('--output=/tmp/x')).toThrow('looks like an option');
    expect(() => checkRev(42)).toThrow('Not a revision');
    expect(() => checkRev('')).toThrow('Empty revision');
    expect(() => checkRev('main\nHEAD')).toThrow('control characters');
  });

  it('takes one of the allowed values', () => {
    const modes = ['three-dot', 'two-dot'] as const;
    expect(checkOneOf(undefined, modes, 'three-dot')).toBe('three-dot');
    expect(checkOneOf('two-dot', modes, 'three-dot')).toBe('two-dot');
    expect(() => checkOneOf('four-dot', modes, 'three-dot')).toThrow('Not one of three-dot, two-dot');
  });

  it('takes lists of file paths only', () => {
    expect(checkFilePaths(['a.txt', 'src/b.ts'])).toEqual(['a.txt', 'src/b.ts']);
    expect(() => checkFilePaths('abc')).toThrow('Not a list of file paths');
    expect(() => checkFilePaths(['/etc/passwd'])).toThrow('Not a list of file paths');
    expect(() => checkFilePaths(['a\0b'])).toThrow('Not a list of file paths');
    expect(() => checkFilePaths([7])).toThrow('Not a list of file paths');
  });
});

describe('validJournal', () => {
  const state = { branch: 'main', head: SHA, refs: { 'refs/heads/main': SHA } };
  const entry = { id: '1', title: 'Commit', before: state, after: state };

  it('keeps a well-formed journal', () => {
    const journal = { id: 'j', undo: [entry], redo: [] };
    expect(validJournal(journal)).toEqual({ ...journal, pending: undefined, stop: undefined });
  });

  it('drops journals with entries that do not check out, without throwing on nulls', () => {
    expect(validJournal(null)).toBeUndefined();
    expect(validJournal({ undo: [{ ...entry, stash: null }], redo: [] })).toBeUndefined();
    expect(validJournal({ undo: [{ ...entry, stash: { removed: null } }], redo: [] })).toBeUndefined();
    expect(validJournal({ undo: [{ ...entry, snapshot: 'a'.repeat(50) }], redo: [] })).toBeUndefined();
    expect(
      validJournal({ undo: [{ ...entry, after: { refs: { 'refs/heads/-x': SHA } } }], redo: [] }),
    ).toBeUndefined();
  });

  it('drops a pending entry or stop record that does not check out, keeping the rest', () => {
    const journal = validJournal({ undo: [], redo: [], pending: { title: 7 }, stop: null });
    expect(journal).toEqual({ id: undefined, undo: [], redo: [], pending: undefined, stop: undefined });
  });
});
