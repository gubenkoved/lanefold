/*
 * Plans for what git stopped in: continue, skip or abort a merge, cherry-pick, revert, rebase,
 * patch application or bisect.
 */

import { readFile } from 'node:fs/promises';
import { isObjectId } from '../../../shared/oid';
import type { Operation, OperationKind, OpState } from '../../../shared/operations';
import { cleanMessage } from '../../../shared/rewrite';
import { revisions } from '../../git/args';
import { sequenceEditorEnv } from '../../rebase/rewrite';
import type { Repository } from '../../repo/repository';
import { abortBlockers, mergeLeftovers, onlyLeftovers, planLeftovers, stepLeftovers } from '../leftovers';
import { sequenceTodo, workSinceStop } from '../opState';
import type { PlanBuilder, PlanContext } from '../planner';
import { plural, quotedSubject, short } from './common';
import { planSplitControl } from './split';

const CONTROL: Record<
  NonNullable<OpState['kind']>,
  { continue?: string[]; skip?: string[]; abort: string[]; label: string }
> = {
  merge: { continue: ['commit', '--no-edit'], abort: ['merge', '--abort'], label: 'merge' },
  'cherry-pick': {
    continue: ['cherry-pick', '--continue'],
    skip: ['cherry-pick', '--skip'],
    abort: ['cherry-pick', '--abort'],
    label: 'cherry-pick',
  },
  revert: {
    continue: ['revert', '--continue'],
    skip: ['revert', '--skip'],
    abort: ['revert', '--abort'],
    label: 'revert',
  },
  rebase: {
    continue: ['rebase', '--continue'],
    skip: ['rebase', '--skip'],
    abort: ['rebase', '--abort'],
    label: 'rebase',
  },
  am: {
    continue: ['am', '--continue'],
    skip: ['am', '--skip'],
    abort: ['am', '--abort'],
    label: 'patch application',
  },
  bisect: { abort: ['bisect', 'reset'], label: 'bisect' },
};

/**
 * The commit an amend with staged changes was folding into, when the rebase in progress started
 * from the “fixup!” commit Lanefold made for it (the branch goes back there on abort).
 */
async function amendedByFixup(repo: Repository): Promise<string | undefined> {
  try {
    const origHead = await readOrigHead(repo);
    if (!origHead) return undefined;
    const { stdout } = await repo.git(['log', '-1', '--format=%B', ...revisions(origHead)], {
      readOnly: true,
      label: 'Read the stopped amend',
    });
    return /^fixup! ([0-9a-f]{40}|[0-9a-f]{64})\s*$/.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}

/** Where the branch was when the rebase in progress started (where an abort puts it back). */
async function readOrigHead(repo: Repository): Promise<string | undefined> {
  const origHead = (await readFile(repo.gitPath('rebase-merge/orig-head'), 'utf8').catch(() => '')).trim();
  return isObjectId(origHead) ? origHead : undefined;
}

/** Where a sequence of picks or reverts started (where an abort puts HEAD back). */
async function readSequenceStart(repo: Repository): Promise<string | undefined> {
  const start = (await readFile(repo.gitPath('sequencer/head'), 'utf8').catch(() => '')).trim();
  return isObjectId(start) ? start : undefined;
}

/** What the stopped operation is called, by what was started: a pull stops in a rebase, say. */
const STARTED: Partial<Record<OperationKind, string>> = {
  pull: 'pull',
  amendInto: 'amend',
  rewrite: 'history edit',
};

export async function planControl(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'continue' | 'skip' | 'abort' }>,
  b: PlanBuilder,
) {
  const kind = ctx.opState.kind;
  if (!kind) {
    b.block('No operation is in progress.', { final: true });
    return op.kind === 'abort' ? 'Abort' : op.kind === 'skip' ? 'Skip' : 'Continue';
  }
  const control = CONTROL[kind];
  // The operation as the user started it names the stop (and its abort).
  const historyEdit = !!ctx.opState.historyEdit;
  const label = historyEdit ? 'history edit' : ((ctx.started && STARTED[ctx.started.kind]) ?? control.label);
  // Stopped at a commit to split: Continue finishes the split (and skipping is refused).
  const split = await planSplitControl(ctx, op, b);
  if (split !== undefined) return split;
  // A step git could not carry out (a file it could not write, say) left some of its changes in
  // the way: Retry, Skip and Abort clear them first, saving anything that is not git's own.
  const failed =
    kind === 'rebase' || kind === 'cherry-pick' || kind === 'revert' ? ctx.opState.failedStep : undefined;
  const leftovers = failed
    ? await stepLeftovers(ctx.repo, failed.commit, { reverse: kind === 'revert' })
    : undefined;
  // A sequence of picks or reverts: what it has still to do, to start it again from the step.
  const sequence = failed && kind !== 'rebase' ? await sequenceTodo(ctx.repo) : undefined;
  const stepName = failed ? (failed.subject ? quotedSubject(failed.subject) : short(failed.commit)) : '';
  if (failed?.reason) b.notice(op.kind === 'continue' ? 'warning' : 'info', failed.reason);
  // Leftovers that hold git's own content are no one's work: nothing to save.
  const onlyStep = leftovers ? await onlyLeftovers(ctx.repo, leftovers) : false;
  // Abort and skip throw away what was changed since git stopped: it is saved first.
  const work =
    op.kind !== 'continue' &&
    kind !== 'bisect' &&
    !onlyStep &&
    (await workSinceStop(ctx.repo, ctx.opState, ctx.stop));
  const saved =
    'Lanefold saves them as a stash first (on top of the stash list), so applying it brings them back.';
  if (op.kind === 'abort') {
    b.action = historyEdit ? 'Stop editing' : kind === 'bisect' ? 'Stop bisecting' : 'Abort';
    // (A split in progress tracks its new files first: the abort puts those back itself.)
    if ((kind === 'rebase' && !ctx.opState.split?.opened) || sequence) {
      // Git puts the branch back only where no untracked file is in the way, and would leave the
      // new files of a step that failed half-way behind.
      const target = kind === 'rebase' ? await readOrigHead(ctx.repo) : await readSequenceStart(ctx.repo);
      const blockers = target ? await abortBlockers(ctx.repo, target) : undefined;
      planLeftovers(
        b,
        mergeLeftovers(
          {
            // A rebase's abort puts tracked files back itself; a cherry-pick's or revert's leaves
            // them as they are.
            restore: sequence ? (leftovers?.restore ?? []) : [],
            remove: leftovers?.remove ?? [],
            save: leftovers?.save ?? [],
          },
          blockers ?? { restore: [], remove: [], save: [] },
        ),
        historyEdit ? 'stopping the history edit' : `aborting the ${label}`,
      );
    }
    b.command(control.abort, `Stop the ${label} and put everything back as it was before it started.`);
    // An amend with staged changes that stopped: its “fixup!” commit becomes staged changes again.
    const amended = kind === 'rebase' ? await amendedByFixup(ctx.repo) : undefined;
    if (amended)
      b.command(
        ['reset', '--soft', 'HEAD~1'],
        `Take back the “fixup!” commit made to amend ${short(amended)}: its changes are staged again, as before.`,
        [['--soft', 'move the branch back only: the changes stay, staged']],
      );
    b.protectWork = kind !== 'bisect' && !onlyStep;
    if (work) {
      b.risk('Discards changes');
      b.notice('warning', `The changes made since git stopped (resolutions, edits) are discarded. ${saved}`);
    }
    return historyEdit ? 'Stop editing history' : kind === 'bisect' ? 'Stop bisecting' : `Abort the ${label}`;
  }
  if (op.kind === 'skip') {
    const commit = ctx.opState.commit ? ` ${short(ctx.opState.commit)}` : '';
    if (!control.skip) b.block(`A ${control.label} cannot skip a step.`, { final: true });
    else if (failed && leftovers && sequence) {
      planLeftovers(b, leftovers, `leaving out ${stepName}`);
      b.command(control.skip, `Leave out ${stepName} and go on.`);
    } else if (failed && leftovers) {
      // git's own skip would run the step again: it is back at the top of the todo.
      if (!ctx.rebaseScript)
        b.block('Leaving out a step that failed needs Lanefold’s sequence editor.', { final: true });
      else {
        planLeftovers(b, leftovers, `leaving out ${stepName}`);
        b.env = { ...sequenceEditorEnv(ctx.rebaseScript), LANEFOLD_TODO_DROP: failed.commit };
        b.command(['rebase', '--edit-todo'], `Take ${stepName} off the todo: it is left out.`);
        b.command(control.continue ?? [], 'Go on with the next step.');
      }
    } else
      b.command(
        control.skip,
        ctx.opState.editStop
          ? `Go on without changing${commit || ' the commit'}: it stays as it is.`
          : `Leave out the current commit${commit} and go on.`,
      );
    b.protectWork = kind !== 'bisect' && !onlyStep;
    // Leaving out a commit changes the result (Undo of the whole edit brings it back).
    if (!ctx.opState.editStop) b.risk('Leaves out a commit');
    if (work) {
      b.risk('Discards changes');
      b.notice('warning', `The changes made since git stopped are discarded. ${saved}`);
    }
    const subject = ctx.opState.commitSubject;
    return `Skip ${subject ? quotedSubject(subject) : short(ctx.opState.commit) || 'this step'}`;
  }
  // A merge can be concluded with a message of the user's own instead of git's.
  const message =
    op.kind === 'continue' && op.message !== undefined ? cleanMessage(String(op.message)) : undefined;
  if (message !== undefined && kind !== 'merge')
    b.block('Only the message of a merge commit can be set here.');
  if (message === '') b.block('Write a message for the merge commit.');
  if (kind === 'merge') b.action = 'Conclude merge';
  const conclude: { args: string[]; flags: [string, string][] } =
    kind === 'merge' && message
      ? { args: ['commit', '-m', message], flags: [['-m', 'the message of the merge commit']] }
      : { args: control.continue ?? [], flags: [] };
  if (!control.continue) b.block(`A ${control.label} cannot be continued from here.`);
  else if (failed && leftovers) {
    planLeftovers(b, leftovers, `retrying ${stepName}`);
    if (sequence && sequence.commits.length > 0) {
      // git's own --continue would take the step for done and leave it out: start the sequence
      // again from it instead.
      const verb = kind === 'revert' ? 'Revert' : 'Pick';
      const later = sequence.commits.length - 1;
      b.command(
        [kind, '--quit'],
        `Forget the ${label} in progress (HEAD stays where it is): git would leave ${stepName} out.`,
      );
      b.command(
        [
          kind,
          ...sequence.options,
          ...(kind === 'revert' ? ['--no-edit'] : []),
          ...revisions(...sequence.commits),
        ],
        `${verb} ${stepName} again${later > 0 ? `, then the ${plural(later, 'commit')} after it` : ''}.`,
      );
    } else b.command(control.continue, `Run ${stepName} again, from the start.`);
    b.action = 'Retry';
    return `Retry ${stepName}`;
  } else if (ctx.opState.editStop && ctx.opState.conflicts.length === 0) {
    // Stopped to edit a commit: what was changed in tracked files goes into it.
    const tree = ctx.workingTree;
    if (tree.unstaged > 0) {
      b.command(['add', '--update'], 'Stage your changes to tracked files.', [
        ['--update', 'only files git already tracks (new files are left out)'],
      ]);
    }
    b.command(
      control.continue,
      tree.staged + tree.unstaged > 0
        ? `Amend the changes into ${short(ctx.opState.commit) || 'the commit'} and continue.`
        : 'Continue with the next step.',
    );
    if (tree.untracked > 0) {
      b.notice(
        'info',
        `${tree.untracked} new file${tree.untracked === 1 ? ' is' : 's are'} not tracked and stay${tree.untracked === 1 ? 's' : ''} out of the commit.`,
      );
    }
    return tree.staged + tree.unstaged > 0
      ? 'Amend and continue'
      : historyEdit
        ? 'Continue editing history'
        : `Continue the ${label}`;
  } else {
    if (kind === 'am' && ctx.opState.conflicts.length === 0 && ctx.workingTree.staged === 0)
      b.block('The patch did not apply: apply its changes by hand and stage them, or skip it.');
    if (ctx.opState.conflicts.length > 0)
      b.block(
        `Resolve the ${ctx.opState.conflicts.length} conflicted file${ctx.opState.conflicts.length === 1 ? '' : 's'} first.`,
      );
    b.command(
      conclude.args,
      kind === 'merge'
        ? 'Record the resolution as the merge commit.'
        : `Record the resolution and continue the ${label}.`,
      conclude.flags,
    );
  }
  return kind === 'merge' && label === 'merge'
    ? 'Conclude the merge'
    : historyEdit
      ? 'Continue editing history'
      : `Continue the ${label}`;
}
