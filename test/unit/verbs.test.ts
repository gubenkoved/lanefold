import { describe, expect, it } from 'vitest';
import { describeDone, firstSentence, quote } from '../../src/core/ops/results';
import { actionLabel, pastTense } from '../../src/core/ops/verbs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('the verbs of operations', () => {
  it('puts titles in the past tense for confirmations', () => {
    expect(pastTense('Delete branch hotfix/timezone')).toBe('Deleted branch hotfix/timezone');
    expect(pastTense('Check out “Update dependencies”')).toBe('Checked out “Update dependencies”');
    expect(pastTense('Cherry-pick 3 commits onto main')).toBe('Cherry-picked 3 commits onto main');
    expect(pastTense('Force push main')).toBe('Force pushed main');
    expect(pastTense('Push main')).toBe('Pushed main');
    expect(pastTense('Reset main to origin/main')).toBe('Reset main to origin/main');
    expect(pastTense('Stop editing history')).toBe('Stopped editing history');
    expect(pastTense('Initialize and update submodules')).toBe('Initialized and updated submodules');
    expect(pastTense('Amend and continue')).toBe('Amended and continued');
    expect(pastTense('Stash changes')).toBe('Stashed changes');
    expect(pastTense('Delete branch feature from origin')).toBe('Deleted branch feature from origin');
    expect(pastTense('Delete 3 branches')).toBe('Deleted 3 branches');
    expect(pastTense('Stop tracking origin/feature')).toBe('Stopped tracking origin/feature');
    expect(pastTense('Set the upstream of x to origin/x')).toBe('Set the upstream of x to origin/x');
    // Only whole words: “Pushover” is no push.
    expect(pastTense('Pushover')).toBe('Pushover');
    expect(pastTense('New worktree')).toBe('New worktree');
  });

  it('names the run button after what it does', () => {
    expect(actionLabel({ kind: 'deleteBranch', name: 'x' })).toBe('Delete branch');
    expect(actionLabel({ kind: 'deleteBranch', name: 'x', remote: true })).toBe('Delete both');
    expect(actionLabel({ kind: 'deleteRemoteBranch', name: 'origin/x' })).toBe('Delete from remote');
    expect(actionLabel({ kind: 'deleteBranches', names: ['x', 'y'] })).toBe('Delete branches');
    expect(actionLabel({ kind: 'setUpstream', branch: 'x', upstream: 'origin/x' })).toBe('Set upstream');
    expect(actionLabel({ kind: 'setUpstream', branch: 'x' })).toBe('Stop tracking');
    expect(actionLabel({ kind: 'renameBranch', from: 'x', to: 'y' })).toBe('Rename');
    expect(actionLabel({ kind: 'renameBranch', from: 'x', to: 'y', remote: true })).toBe('Rename both');
    expect(pastTense('Rename x to y, here and on origin')).toBe('Renamed x to y, here and on origin');
    expect(actionLabel({ kind: 'push', force: true })).toBe('Force push');
    expect(actionLabel({ kind: 'push' })).toBe('Push');
    expect(actionLabel({ kind: 'stashApply', stash: A, pop: true })).toBe('Pop');
    expect(actionLabel({ kind: 'commit', message: '', amend: true })).toBe('Amend');
    expect(actionLabel({ kind: 'bisectMark', verdict: 'good' })).toBe('Mark good');
    expect(actionLabel({ kind: 'updateSubmodules', init: true })).toBe('Initialize');
  });
});

describe('result wording', () => {
  it('quotes text, with quotes inside it single', () => {
    expect(quote('Delete branch x')).toBe('“Delete branch x”');
    expect(quote('Revert “Fix it”')).toBe('“Revert ‘Fix it’”');
  });

  it('takes a message’s first sentence as a headline', () => {
    expect(firstSentence('Pushed main to origin (2 commits).')).toBe('Pushed main to origin (2 commits)');
    expect(firstSentence('Fetched origin: 2 updated. 1 new tag.')).toBe('Fetched origin: 2 updated');
    expect(firstSentence('v1.0 is on origin now.')).toBe('v1.0 is on origin now');
    expect(firstSentence('No period')).toBe('No period');
  });

  it('describes what an operation changed without repeating its headline', () => {
    const on = (branch: string | undefined, head: string, refs: Record<string, string>) => ({
      branch,
      head,
      refs,
    });
    // A plain switch: the headline said it all.
    expect(
      describeDone(on('main', A, { 'refs/heads/main': A }), on(undefined, B, { 'refs/heads/main': A })),
    ).toBe('');
    // A deleted branch says where it was (Undo brings it back there).
    expect(
      describeDone(
        on('main', A, { 'refs/heads/main': A, 'refs/heads/old': B }),
        on('main', A, { 'refs/heads/main': A }),
      ),
    ).toBe(`old was at ${B.slice(0, 8)}`);
    expect(
      describeDone(on('main', A, { 'refs/heads/main': A }), on('main', B, { 'refs/heads/main': B })),
    ).toBe(`main → ${B.slice(0, 8)}`);
    expect(
      describeDone(on('main', A, { 'refs/heads/main': A }), on('main', A, { 'refs/heads/main': A })),
    ).toBe('Nothing changed');
  });
});
