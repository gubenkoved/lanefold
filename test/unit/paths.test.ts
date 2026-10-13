import { describe, expect, it } from 'vitest';
import { pathRules } from '../../src/core/util/paths';

describe('file paths compared as VS Code compares them', () => {
  it('on Windows, the drive letter and folder names match whatever their case', () => {
    const win = pathRules('win32');
    // VS Code reports c:\…, git reports C:/… with the on-disk case.
    expect(win.relativeInside('C:/Work/Repo', 'c:\\work\\repo\\src\\App.ts')).toBe('src/App.ts');
    expect(win.relativeInside('C:\\Work\\Repo', 'c:\\work\\repo')).toBe('');
    expect(win.same('C:/Work/Repo', 'c:\\work\\repo\\')).toBe(true);
    expect(win.relativeInside('C:\\Work\\Repo', 'c:\\work\\repository\\a.ts')).toBeUndefined();
    expect(win.relativeInside('C:\\Work\\Repo', 'd:\\work\\repo\\a.ts')).toBeUndefined();
  });

  it('on macOS, case does not matter either; on Linux it does', () => {
    expect(pathRules('darwin').relativeInside('/Users/Ann/Repo', '/users/ann/repo/Docs/A.md')).toBe(
      'Docs/A.md',
    );
    expect(pathRules('linux').relativeInside('/home/ann/Repo', '/home/ann/repo/a.md')).toBeUndefined();
    expect(pathRules('linux').relativeInside('/home/ann/repo', '/home/ann/repo/a/b.md')).toBe('a/b.md');
  });

  it('a folder is only a prefix at a separator, and the root contains everything', () => {
    const linux = pathRules('linux');
    expect(linux.relativeInside('/repo', '/repository/a')).toBeUndefined();
    expect(linux.relativeInside('/repo/', '/repo/a/../b')).toBe('b');
    expect(linux.relativeInside('/', '/repo/a')).toBe('repo/a');
    expect(linux.relativeInside('/repo/a', '/repo')).toBeUndefined();
  });
});
