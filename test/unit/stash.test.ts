import { describe, expect, it } from 'vitest';
import { parseStashList, parseStashSubject } from '../../src/core/repo/stash';

describe('stash list parsing', () => {
  it('splits the subjects git writes', () => {
    expect(parseStashSubject('On main: work: notes')).toEqual({
      message: 'work: notes',
      generated: false,
      branch: 'main',
    });
    expect(parseStashSubject('WIP on feature/x: 1a2b3c4 Add things')).toEqual({
      message: '1a2b3c4 Add things',
      generated: true,
      branch: 'feature/x',
    });
    expect(parseStashSubject('On (no branch): detached')).toEqual({
      message: 'detached',
      generated: false,
      branch: undefined,
    });
    expect(parseStashSubject('autostash')).toEqual({ message: 'autostash', generated: false });
  });

  it('parses NUL-separated records, newest first', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const stdout = [
      a,
      `${'1'.repeat(40)} ${'2'.repeat(40)} ${'3'.repeat(40)}`,
      '1700000000',
      'On main: with untracked',
      b,
      `${'4'.repeat(40)} ${'5'.repeat(40)}`,
      '1690000000',
      'WIP on main: 4444444 subject',
      '',
    ].join('\0');
    expect(parseStashList(stdout)).toEqual([
      {
        index: 0,
        sha: a,
        subject: 'On main: with untracked',
        message: 'with untracked',
        generated: false,
        branch: 'main',
        base: '1'.repeat(40),
        untracked: true,
        time: 1700000000,
      },
      {
        index: 1,
        sha: b,
        subject: 'WIP on main: 4444444 subject',
        message: '4444444 subject',
        generated: true,
        branch: 'main',
        base: '4'.repeat(40),
        untracked: false,
        time: 1690000000,
      },
    ]);
    expect(parseStashList('')).toEqual([]);
  });
});
