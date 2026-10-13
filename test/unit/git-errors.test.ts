import { describe, expect, it } from 'vitest';
import { classifyGitError, GitError } from '../../src/core/git/errors';

describe('classifyGitError', () => {
  it('extracts files from a dirty-worktree checkout failure', () => {
    const stderr = [
      'error: Your local changes to the following files would be overwritten by checkout:',
      '\tsrc/a.ts',
      '\tREADME.md',
      'Please commit your changes or stash them before you switch branches.',
      'Aborting',
    ].join('\n');
    expect(classifyGitError(stderr)).toEqual({ kind: 'dirtyWorkTree', files: ['src/a.ts', 'README.md'] });
  });

  it('recognizes a cherry-pick or revert refused for staged changes', () => {
    const stderr = [
      'error: your local changes would be overwritten by cherry-pick.',
      'hint: commit your changes or stash them to proceed.',
      'fatal: cherry-pick failed',
    ].join('\n');
    expect(classifyGitError(stderr)).toEqual({ kind: 'dirtyWorkTree', files: [] });
    expect(classifyGitError('error: your local changes would be overwritten by revert.').kind).toBe(
      'dirtyWorkTree',
    );
  });

  it('recognizes a git that does not know who you are', () => {
    const stderr = [
      'Author identity unknown',
      '',
      '*** Please tell me who you are.',
      '',
      'Run',
      '',
      '  git config --global user.email "you@example.com"',
      '  git config --global user.name "Your Name"',
      '',
      "fatal: unable to auto-detect email address (got 'runner@ubuntu-vm.(none)')",
    ].join('\n');
    expect(classifyGitError(stderr).kind).toBe('identityUnknown');
  });

  it('detects untracked files in the way', () => {
    const stderr = [
      'error: The following untracked working tree files would be overwritten by checkout:',
      '\tnew.txt',
      'Please move or remove them before you switch branches.',
    ].join('\n');
    expect(classifyGitError(stderr)).toEqual({ kind: 'untrackedOverwritten', files: ['new.txt'] });
  });

  it('collects conflicted paths', () => {
    const stdout = [
      'Auto-merging a.txt',
      'CONFLICT (content): Merge conflict in a.txt',
      'CONFLICT (add/add): Merge conflict in dir/b.txt',
      'Automatic merge failed; fix conflicts and then commit the result.',
    ].join('\n');
    expect(classifyGitError('', stdout)).toEqual({ kind: 'conflict', files: ['a.txt', 'dir/b.txt'] });
  });

  it.each([
    [' ! [rejected]        main -> main (non-fast-forward)', 'nonFastForward'],
    ['fatal: The current branch topic has no upstream branch.', 'noUpstream'],
    ["fatal: Unable to create '/r/.git/index.lock': File exists.", 'lockFile'],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'authFailed'],
    ['git@github.com: Permission denied (publickey).', 'authFailed'],
    ["fatal: unable to access 'https://x/': Could not resolve host: x", 'networkError'],
    ['fatal: not a git repository (or any of the parent directories): .git', 'notARepository'],
    ["fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.", 'badRevision'],
    ["fatal: a branch named 'main' already exists", 'refExists'],
    ["error: the branch 'topic' is not fully merged.", 'branchNotFullyMerged'],
    ['error: gpg failed to sign the data', 'signingFailed'],
    ['something completely different', 'unknown'],
  ])('classifies %j as %s', (stderr, kind) => {
    expect(classifyGitError(stderr).kind).toBe(kind);
  });

  it('classifies nothing-to-commit from stdout', () => {
    expect(classifyGitError('', 'On branch main\nnothing to commit, working tree clean').kind).toBe(
      'nothingToCommit',
    );
  });
});

describe('GitError', () => {
  it('summarizes the first stderr line with the command', () => {
    const error = new GitError(['checkout', 'nope'], 1, "error: pathspec 'nope' did not match\n", '');
    expect(error.message).toBe("git checkout nope failed: pathspec 'nope' did not match");
    expect(error.kind).toBe('unknown');
  });
});
