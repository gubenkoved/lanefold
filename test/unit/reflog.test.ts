import { describe, expect, it } from 'vitest';
import { parseReflog, parseReflogSubject, parseReflogTimes } from '../../src/core/repo/reflog';
import type { ReflogEntry } from '../../src/shared/models';
import { describeReflog, reflogMessage, type HeadBranch } from '../../src/webview/views/reflog/reflogText';

describe('reflog parsing', () => {
  it('splits what moved HEAD from the details', () => {
    expect(parseReflogSubject('checkout: moving from main to topic')).toEqual({
      action: 'checkout',
      detail: 'moving from main to topic',
    });
    expect(parseReflogSubject('rebase (finish): returning to refs/heads/main')).toEqual({
      action: 'rebase (finish)',
      detail: 'returning to refs/heads/main',
    });
    expect(parseReflogSubject('lanefold: Undo: Commit: x')).toEqual({
      action: 'lanefold',
      detail: 'Undo: Commit: x',
    });
    expect(parseReflogSubject('weird')).toEqual({ action: 'weird', detail: '' });
  });

  it('reads entries newest first, with git’s numbers and each one’s time', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    // git leaves out HEAD@{1} (it has no commit for it) but counts it.
    const stdout = [
      a,
      'HEAD@{0}',
      'commit: Two',
      'Two',
      b,
      'HEAD@{2}',
      'commit (initial): One',
      'One',
      '',
    ].join('\0');
    const times = parseReflogTimes([a, 'HEAD@{1700000100}', b, 'HEAD@{1700000000}', ''].join('\0'));
    expect(times).toEqual([
      { sha: a, time: 1700000100 },
      { sha: b, time: 1700000000 },
    ]);
    expect(
      parseReflog(
        stdout,
        times.map((entry) => entry.time),
      ),
    ).toEqual([
      { index: 0, sha: a, action: 'commit', detail: 'Two', time: 1700000100, subject: 'Two' },
      { index: 2, sha: b, action: 'commit (initial)', detail: 'One', time: 1700000000, subject: 'One' },
    ]);
  });
});

let next = 0;

/** A reflog entry as git wrote it, with the subject of the commit HEAD moved to. */
function entry(message: string, subject = 'Some work', sha?: string): ReflogEntry {
  const index = next++;
  return {
    index,
    sha: sha ?? (index.toString(16).padStart(2, '0') + 'c0ffee').repeat(5),
    ...parseReflogSubject(message),
    time: 0,
    subject,
    lost: false,
  };
}

/** Each entry's words, newest first, with HEAD on `head` now. */
const words = (head: HeadBranch, ...entries: ReflogEntry[]) => describeReflog(entries, head);

describe('reflog entries in words', () => {
  it('names commits by their subject', () => {
    expect(
      words(
        'main',
        entry('commit (amend): Add login, tested', 'Add login, tested'),
        entry('commit: Add login', 'Add login'),
        entry('commit (merge): Merge branch ’feature’', 'Merge branch ’feature’'),
        entry('commit (initial): Start', 'Start'),
      ),
    ).toEqual([
      'Amended “Add login, tested”',
      'Committed “Add login”',
      'Committed “Merge branch ’feature’”',
      'Committed “Start”',
    ]);
  });

  it('says which branch a reset moved, and to which commit', () => {
    const sha = '4b533950'.padEnd(40, '0');
    const reset = () => entry('reset: moving to HEAD@{1}', 'Add dark mode toggle', sha);
    expect(words('main', reset())).toEqual(['Reset main to 4b533950 “Add dark mode toggle”']);
    expect(words(null, reset())).toEqual(['Reset HEAD to 4b533950 “Add dark mode toggle”']);
    expect(words(undefined, reset())).toEqual(['Reset to 4b533950 “Add dark mode toggle”']);
  });

  it('follows checkouts back: what happened before one, happened on the branch it left', () => {
    const detached = 'f'.repeat(40);
    const target = '1234abcd'.padEnd(40, '0');
    expect(
      words(
        'main',
        entry(`checkout: moving from ${detached} to main`, 'Tip'),
        entry('reset: moving to HEAD~1', 'Older', '9'.repeat(40)),
        entry('checkout: moving from feature to HEAD~2', 'Older', target),
        entry('commit: Feature work', 'Feature work'),
        entry('checkout: moving from main to feature', 'Base'),
        entry('reset: moving to HEAD', 'Base', 'e'.repeat(40)),
      ),
    ).toEqual([
      'Checked out main',
      'Reset HEAD to 99999999 “Older”',
      'Checked out 1234abcd “Older” (detached HEAD)',
      'Committed “Feature work”',
      'Checked out feature',
      'Reset main to eeeeeeee “Base”',
    ]);
  });

  it('tells branches from other names when where HEAD went is not known', () => {
    expect(words(undefined, entry('checkout: moving from main to feature/login'))).toEqual([
      'Checked out feature/login',
    ]);
    expect(
      words(undefined, entry('checkout: moving from main to 4b53395', 'Fix', '4b533950'.padEnd(40, '1'))),
    ).toEqual(['Checked out 4b533950 “Fix” (detached HEAD)']);
    // A tag or a remote branch leaves HEAD detached.
    expect(words(null, entry('checkout: moving from main to v1.0'))).toEqual([
      'Checked out v1.0 (detached HEAD)',
    ]);
  });

  it('tells a rebase from its start to its end, and the branch it replays', () => {
    const onto = '4b533950'.padEnd(40, '2');
    expect(
      words(
        'topic',
        entry('rebase (finish): returning to refs/heads/topic', 'Topic work'),
        entry('rebase (pick): Topic work', 'Topic work'),
        entry('rebase: fast-forward', 'Base'),
        entry('rebase (start): checkout main', 'Base'),
        entry('rebase -i (finish): returning to refs/heads/topic', 'Topic work'),
        entry('rebase -i (squash): Topic work', 'Topic work'),
        entry('rebase -i (start): checkout HEAD~2', 'Add dark mode toggle', onto),
        entry('reset: moving to HEAD', 'Topic work', 'a'.repeat(40)),
        entry('rebase (abort): returning to refs/heads/topic', 'Topic work'),
      ),
    ).toEqual([
      'Rebased topic',
      'Rebasing topic: picked “Topic work”',
      'Rebasing topic: fast-forwarded',
      'Started rebasing topic onto main',
      'Rebased topic',
      'Rebasing topic: squashed “Topic work”',
      'Started rebasing topic onto 4b533950 “Add dark mode toggle”',
      'Reset topic to aaaaaaaa “Topic work”',
      'Aborted rebasing topic',
    ]);
    // In the middle of one: HEAD is detached, the branch is not known yet.
    expect(
      words(null, entry('rebase (continue): Fix', 'Fix'), entry('rebase (start): checkout main')),
    ).toEqual(['Rebasing: continued with “Fix”', 'Started a rebase onto main']);
  });

  it('tells merges and pulls, and into which branch', () => {
    expect(
      words(
        'main',
        entry('merge feature/login: Fast-forward'),
        entry("merge hotfix: Merge made by the 'ort' strategy."),
        entry('pull: Fast-forward'),
        entry("pull: Merge made by the 'ort' strategy."),
        entry('pull --rebase (finish): returning to refs/heads/main'),
        entry('pull --rebase (pick): Local work', 'Local work'),
        entry('pull --rebase (start): checkout 0123456789abcdef0123456789abcdef01234567'),
      ),
    ).toEqual([
      'Merged feature/login into main (fast-forward)',
      'Merged hotfix into main',
      'Pulled into main (fast-forward)',
      'Pulled into main (merge)',
      'Pulled into main (rebase)',
      'Pulling main: picked “Local work”',
      'Started pulling into main (rebase)',
    ]);
  });

  it('tells picks, reverts, patches, renames and clones', () => {
    expect(
      words(
        'trunk',
        entry('cherry-pick: Side work', 'Side work'),
        entry('revert: Revert "Side work"', 'Revert "Side work"'),
        entry('am: Fix the docs', 'Fix the docs'),
        entry('Branch: renamed refs/heads/main to refs/heads/trunk'),
        entry('reset: moving to HEAD', 'Base', 'b'.repeat(40)),
        entry('clone: from https://example.com/aurora.git'),
      ),
    ).toEqual([
      'Cherry-picked “Side work”',
      'Reverted “Side work”',
      'Applied the patch “Fix the docs”',
      'Renamed main to trunk',
      'Reset main to bbbbbbbb “Base”',
      'Cloned from https://example.com/aurora.git',
    ]);
  });

  it('names Lanefold’s operations by their titles', () => {
    expect(
      words(
        'main',
        entry('lanefold: Undo: Commit to main: updating HEAD', 'Base'),
        entry('lanefold: Commit to main: Add notes', 'Add notes'),
        entry('lanefold: Reset main to 6b62a913: updating HEAD', 'Two'),
        entry(
          "lanefold: Merge feature into main: Merge made by the 'ort' strategy.",
          "Merge branch 'feature'",
        ),
        entry('lanefold: Merge hotfix into main: Fast-forward', 'Fix'),
        entry('lanefold: Revert b553028a: Revert "Feature work"', 'Revert "Feature work"'),
        entry('lanefold: Rebase main onto origin/main (finish): returning to refs/heads/main', 'Mine'),
        entry('lanefold: Rebase main onto origin/main (pick): Mine', 'Mine'),
        entry('lanefold: Rebase main onto origin/main (start): checkout origin/main', 'Theirs'),
        entry('lanefold: Stash “WIP”: updating HEAD', 'Theirs'),
        entry('reset: moving to HEAD~1', 'Older', 'c'.repeat(40)),
      ),
    ).toEqual([
      'Lanefold: Undo: Commit to main',
      'Lanefold: Commit to main “Add notes”',
      'Lanefold: Reset main to 6b62a913',
      'Lanefold: Merge feature into main',
      'Lanefold: Merge hotfix into main (fast-forward)',
      'Lanefold: Revert b553028a “Feature work”',
      'Lanefold: Rebase main onto origin/main',
      'Lanefold: Rebase main onto origin/main (picked “Mine”)',
      'Lanefold: Rebase main onto origin/main (started)',
      'Lanefold: Stash “WIP”',
      // Lanefold's operations that stay on the branch keep it known.
      'Reset main to cccccccc “Older”',
    ]);
  });

  it('does not guess the branch before a switch Lanefold made', () => {
    expect(
      words(
        'feature',
        entry('lanefold: Check out feature', 'Feature'),
        entry('reset: moving to HEAD~1', 'Older', 'd'.repeat(40)),
      ),
    ).toEqual(['Lanefold: Check out feature', 'Reset to dddddddd “Older”']);
  });

  it('shows what it does not know as git wrote it', () => {
    const odd = entry('filter-branch: rewrite');
    expect(words('main', odd)).toEqual(['filter-branch: rewrite']);
    expect(reflogMessage(odd)).toBe('filter-branch: rewrite');
    expect(reflogMessage(entry('weird'))).toBe('weird');
  });
});
