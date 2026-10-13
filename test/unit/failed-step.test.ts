import { describe, expect, it } from 'vitest';
import { classifyGitError, filesInUse, GitError } from '../../src/core/git/errors';
import { mergeLeftovers, sortLeftover } from '../../src/core/ops/leftovers';
import { describeGitFailure, describeStaleFiles } from '../../src/core/ops/results';

/** What git for Windows printed when a file was held open mid-rebase (progress ends in \r). */
const WINDOWS = [
  'Rebasing (1/19)\rRebasing (2/19)\rRebasing (16/19)\rerror: unable to unlink old ',
  "'src/app/config.cpp': Invalid argument\n",
  'hint: Could not execute the todo command\nhint:\nhint:     pick 369d27c9e79b00877747ed34e18fedad95110cf3\n',
  'hint:\nhint: It has been rescheduled; To edit the command before continuing, please\n',
].join('');

const failure = (stderr: string) => new GitError(['rebase', '--continue'], 1, stderr, '');

describe('a file git could not replace', () => {
  it('is told apart from other failures, past the progress git prints before it', () => {
    expect(classifyGitError(WINDOWS)).toEqual({ kind: 'fileInUse', files: ['src/app/config.cpp'] });
    expect(classifyGitError("error: unable to unlink old 'dir/a.txt': Permission denied\n")).toEqual({
      kind: 'fileInUse',
      files: ['dir/a.txt'],
    });
    expect(classifyGitError('error: unable to create file docs/x.md: Permission denied\n')).toMatchObject({
      kind: 'fileInUse',
      files: ['docs/x.md'],
    });
    expect(
      classifyGitError("Unlink of file 'build/app.exe' failed. Should I try again? (y/n)"),
    ).toMatchObject({
      kind: 'fileInUse',
      files: ['build/app.exe'],
    });
  });

  it('is explained in plain words, with what to do', () => {
    expect(describeGitFailure(failure(WINDOWS))).toBe(
      'Git could not replace src/app/config.cpp (Invalid argument): another program may have it open, such as an editor, a build or antivirus. Close it, then retry.',
    );
    expect(describeGitFailure(failure('error: unable to create file docs/x.md: Permission denied\n'))).toBe(
      'Git could not write docs/x.md (Permission denied): another program may have it open, such as an editor, a build or antivirus. Close it, then retry.',
    );
  });

  it('lists every file git names, once, with its reason, and tells writing apart from replacing', () => {
    const text = [
      "error: unable to unlink old 'a.txt': Permission denied",
      "error: unable to unlink old 'b.txt': Invalid argument",
      "error: unable to unlink old 'a.txt': Permission denied",
      "error: unable to write file 'c.txt' mode 100644: Device or resource busy",
      "warning: unable to unlink 'd.txt': No such file or directory",
    ].join('\n');
    expect(filesInUse(text)).toEqual([
      { path: 'a.txt', writing: false, reason: 'Permission denied' },
      { path: 'b.txt', writing: false, reason: 'Invalid argument' },
      { path: 'c.txt', writing: true, reason: 'Device or resource busy' },
    ]);
    expect(classifyGitError(text)).toEqual({ kind: 'fileInUse', files: ['a.txt', 'b.txt', 'c.txt'] });
    // A full disk is not a file in use.
    expect(filesInUse("error: unable to write file 'c.txt' mode 100644: No space left on device")).toEqual(
      [],
    );
    expect(describeGitFailure(failure(text))).toBe(
      'Git could not replace a.txt, b.txt and 1 more file (Permission denied): another program may have them open, such as an editor, a build or antivirus. Close it, then retry.',
    );
  });

  it('says which files a switch left as they were, and what to do', () => {
    expect(describeStaleFiles([{ path: 'dir/a.txt', writing: false, reason: 'Invalid argument' }])).toBe(
      'dir/a.txt still has the old content: git could not update it (Invalid argument). Close the program that has it open, then update it.',
    );
    expect(
      describeStaleFiles([
        { path: 'a.txt', writing: false },
        { path: 'b.txt', writing: false },
      ]),
    ).toBe(
      'a.txt and b.txt still have the old content: git could not update them. Close the program that has them open, then update them.',
    );
  });

  it('names the failure by git’s error line, not by its progress', () => {
    expect(failure(WINDOWS).message).toBe(
      "git rebase --continue failed: unable to unlink old 'src/app/config.cpp': Invalid argument",
    );
    // Other failures are found past the progress too.
    expect(describeGitFailure(failure('Rebasing (2/3)\rerror: could not write index\n'))).toBe(
      'could not write index',
    );
  });
});

describe('what a failed step left behind', () => {
  const head = 'h'.repeat(40);
  const step = 's'.repeat(40);
  const other = 'o'.repeat(40);

  it('leaves alone what is as it was', () => {
    expect(sortLeftover({ path: 'a', head, step, index: head, disk: head })).toBe('clean');
    expect(sortLeftover({ path: 'gone', head: undefined, step, index: undefined, disk: undefined })).toBe(
      'clean',
    );
  });

  it('puts back what holds git’s own content: the step writes it again', () => {
    // Written by the step, on disk or staged too.
    expect(sortLeftover({ path: 'a', head, step, index: head, disk: step })).toBe('restore');
    expect(sortLeftover({ path: 'a', head, step, index: step, disk: step })).toBe('restore');
    // Deleted by the step.
    expect(sortLeftover({ path: 'a', head, step: undefined, index: head, disk: undefined })).toBe('restore');
    // New in the step: written, maybe staged.
    expect(sortLeftover({ path: 'n', head: undefined, step, index: undefined, disk: step })).toBe('remove');
    expect(sortLeftover({ path: 'n', head: undefined, step, index: step, disk: step })).toBe('remove');
  });

  it('saves anything else first: someone’s edits, a half-written file, a folder in the way', () => {
    expect(sortLeftover({ path: 'a', head, step, index: head, disk: other })).toBe('save');
    expect(sortLeftover({ path: 'a', head, step, index: other, disk: step })).toBe('save');
    expect(sortLeftover({ path: 'n', head: undefined, step, index: undefined, disk: other })).toBe('save');
    expect(sortLeftover({ path: 'd', head, step, index: head, disk: 'dir' })).toBe('save');
  });

  it('merges two lists, each path once, saving winning over removing', () => {
    expect(
      mergeLeftovers(
        { restore: ['a'], remove: ['n', 'm'], save: ['s'] },
        { restore: ['a'], remove: ['n'], save: ['m'] },
      ),
    ).toEqual({ restore: ['a'], remove: ['n'], save: ['s', 'm'] });
  });
});
