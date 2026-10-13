import { describe, expect, it } from 'vitest';
import { classifyGitDirChange } from '../../src/core/repo/changes';

describe('classifyGitDirChange', () => {
  it.each([
    ['HEAD', 'head'],
    ['index', 'index'],
    ['refs/heads/main', 'refs'],
    ['refs/remotes/origin/feature/x', 'refs'],
    ['refs/tags/v1', 'refs'],
    ['refs/stash', 'stash'],
    ['logs/refs/stash', 'stash'],
    ['packed-refs', 'refs'],
    ['reftable/tables.list', 'refs'],
    ['FETCH_HEAD', 'refs'],
    ['ORIG_HEAD', 'refs'],
    ['MERGE_HEAD', 'opState'],
    ['CHERRY_PICK_HEAD', 'opState'],
    ['rebase-merge/msgnum', 'opState'],
    ['rebase-apply/next', 'opState'],
    ['sequencer/todo', 'opState'],
    ['BISECT_LOG', 'opState'],
    ['config', 'config'],
    ['refs\\heads\\win', 'refs'],
    // A submodule's own git dir: its commits and checkouts change this repository's status.
    ['modules/libs/lib/HEAD', 'worktree'],
    ['modules/libs/lib/refs/heads/main', 'worktree'],
    ['modules/lib/packed-refs', 'worktree'],
    ['modules/app/modules/inner/HEAD', 'worktree'],
  ])('%s → %s', (path, kind) => {
    expect(classifyGitDirChange(path)).toBe(kind);
  });

  it.each([
    'objects/ab/cdef',
    'logs/HEAD',
    'logs/refs/heads/main',
    'index.lock',
    'refs/heads/main.lock',
    'COMMIT_EDITMSG',
    '',
    'hooks/pre-commit',
    'modules/libs/lib/index',
    'modules/libs/lib/objects/ab/cdef',
    'modules/libs/lib/ORIG_HEAD',
    'modules/libs/lib/refs/remotes/origin/main',
    'modules/libs/lib/HEAD.lock',
  ])('ignores %j', (path) => {
    expect(classifyGitDirChange(path)).toBeUndefined();
  });
});
