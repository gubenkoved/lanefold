import type { OpState } from '../../../shared/operations';
import type { RowMark } from '../../graph/GraphView';

/**
 * Status chips for the commits an operation in progress is about: a rebase's replayed, current
 * and pending commits; the commit being merged or picked; a bisect's verdicts so far.
 */
export function operationMarks(state: OpState | undefined): ReadonlyMap<string, RowMark> | undefined {
  if (!state?.kind || state.running) return undefined;
  const marks = new Map<string, RowMark>();
  const conflicted = state.conflicts.length > 0;
  switch (state.kind) {
    case 'rebase': {
      const steps = state.steps;
      if (steps) {
        const total = steps.done.length + steps.todo.length;
        steps.done.forEach((sha, index) =>
          marks.set(sha, {
            label: 'replayed',
            icon: 'check',
            tone: 'done',
            title: `Step ${index + 1} of ${total}: replayed already`,
          }),
        );
        steps.todo.forEach((sha, index) =>
          marks.set(sha, {
            label: 'to replay',
            icon: 'circle-large-outline',
            tone: 'pending',
            title: `Step ${steps.done.length + index + 1} of ${total}: still to come`,
          }),
        );
      }
      // Git stopped at the last commit it took up.
      if (state.commit)
        marks.set(state.commit, {
          label: conflicted ? 'conflict' : state.editStop ? 'editing' : 'stopped',
          icon: conflicted ? 'warning' : state.editStop ? 'edit' : 'debug-pause',
          tone: conflicted ? 'bad' : 'current',
          title: conflicted
            ? 'Replaying this commit stopped on conflicts'
            : state.editStop
              ? 'Stopped here so the commit can be changed'
              : 'The rebase stopped at this commit',
        });
      // A commit being split, and the parts made of it so far.
      const split = state.split;
      if (split && !conflicted) {
        marks.set(split.commit, {
          label: 'splitting',
          icon: 'split-vertical',
          tone: 'current',
          title: split.opened
            ? 'Being split: its changes are uncommitted, to be committed in parts'
            : 'Stopped here to split it',
        });
        split.parts.forEach((part, index) =>
          marks.set(part.sha, {
            label: `part ${index + 1}`,
            icon: 'split-vertical',
            tone: 'done',
            title: `Part ${index + 1} of the commit being split`,
          }),
        );
      }
      break;
    }
    case 'merge':
    case 'cherry-pick':
    case 'revert':
      if (state.commit)
        marks.set(state.commit, {
          label: state.kind === 'merge' ? 'merging' : state.kind === 'revert' ? 'reverting' : 'picking',
          icon: state.kind === 'merge' ? 'git-merge' : state.kind === 'revert' ? 'discard' : 'git-commit',
          tone: conflicted ? 'bad' : 'current',
          title: conflicted ? 'Stopped on conflicts' : undefined,
        });
      break;
    case 'bisect': {
      const bisect = state.bisect;
      if (!bisect) break;
      for (const sha of bisect.good)
        marks.set(sha, { label: 'good', icon: 'pass', tone: 'good', title: 'Marked good' });
      for (const sha of bisect.skipped)
        marks.set(sha, { label: 'skipped', icon: 'debug-step-over', tone: 'muted', title: 'Skipped' });
      if (bisect.bad)
        marks.set(bisect.bad, { label: 'bad', icon: 'error', tone: 'bad', title: 'Marked bad' });
      if (bisect.firstBad)
        marks.set(bisect.firstBad, {
          label: 'first bad',
          icon: 'bug',
          tone: 'bad',
          title: 'The first commit with the problem',
        });
      else if (bisect.current && !marks.has(bisect.current))
        marks.set(bisect.current, {
          label: 'testing',
          icon: 'beaker',
          tone: 'current',
          title: 'Checked out for testing: mark it good or bad',
        });
      break;
    }
  }
  return marks.size > 0 ? marks : undefined;
}
