import { describe, expect, it } from 'vitest';
import { parseWorktrees } from '../../src/core/repo/worktrees';

describe('parseWorktrees', () => {
  const records = [
    ['worktree /work/app', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', ''],
    [
      'worktree /work/app-fix',
      'HEAD 2222222222222222222222222222222222222222',
      'detached',
      'locked moving',
      '',
    ],
  ];

  it('reads -z output, and the newline output of git before 2.36 the same way', () => {
    const z = records.map((fields) => fields.join('\0')).join('\0');
    const lines = records
      .map((fields) => fields.join('\n'))
      .join('\n')
      .replace(/\n/g, '\0');
    for (const stdout of [z, lines]) {
      expect(parseWorktrees(stdout, '/work/app-fix')).toEqual([
        expect.objectContaining({ path: '/work/app', branch: 'main', main: true, current: false }),
        expect.objectContaining({ path: '/work/app-fix', locked: 'moving', main: false, current: true }),
      ]);
    }
  });
});
