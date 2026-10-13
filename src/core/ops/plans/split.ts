import type { Operation, SplitState } from '../../../shared/operations';
import {
  changedPaths,
  editStopCommit,
  ignoredFiles,
  literalPathArgs,
  splitStepArgs,
  type SplitStep,
} from '../../rebase/split';
import type { PlanBuilder, PlanContext } from '../planner';
import { describePaths, plural, short } from './common';

/*
 * Plans for the steps of splitting a commit while a history edit is stopped at it: taking it
 * apart, committing its parts, finishing it (Continue) and aborting. The history edit itself is
 * planned in planRewrite, where a split is an `edit` stop. The commands shown come from
 * splitStepArgs, which is also what runs them.
 */

/** What the flags of `git add -A` mean here. */
function addFlags(add: { readonly stdin?: string; readonly force?: boolean }): [string, string][] {
  return [
    ['-A', 'new and deleted files too'],
    ...(add.force
      ? ([['-f', 'also the files git ignores that the commit holds']] as [string, string][])
      : []),
    ...(add.stdin
      ? ([['--pathspec-from-file=-', 'the files, read from standard input (there are many)']] as [
          string,
          string,
        ][])
      : []),
  ];
}

/** 3f2a1b9c “Add dashboard” */
function named(split: SplitState): string {
  const subject = split.subject.length > 60 ? `${split.subject.slice(0, 59)}…` : split.subject;
  return `${short(split.commit)} “${subject}”`;
}

/**
 * Takes the commit a history edit stopped at apart, when that did not happen on its own: git got
 * there outside Lanefold (continued from a terminal), or stopped on a conflict first.
 */
export async function planStartSplit(ctx: PlanContext, b: PlanBuilder): Promise<string> {
  const split = ctx.opState.split;
  if (!split) {
    b.block(ctx.opState.kind ? 'Git is not stopped at a commit to split.' : 'No operation is in progress.');
    return 'Split the commit';
  }
  const title = `Split ${short(split.commit)}`;
  if (split.opened) {
    b.block(`${named(split)} is taken apart already: its changes are uncommitted.`);
    return title;
  }
  const conflicts = ctx.opState.conflicts.length;
  if (conflicts > 0) {
    b.block(`Resolve the ${plural(conflicts, 'conflicted file')} first.`);
    return title;
  }
  // At its edit stop git committed it (HEAD is that commit); after a conflict, the resolution is
  // staged on top of its parent instead.
  const stopped = await editStopCommit(ctx.repo);
  if (stopped && stopped !== ctx.head.sha) {
    b.block('HEAD moved since git stopped here. Continue or abort the history edit instead.');
    return title;
  }
  const step: SplitStep = { step: 'open', commit: split.commit, from: stopped ? 'commit' : 'resolution' };
  const [reset] = splitStepArgs(step);
  if (step.from === 'commit') {
    b.command(
      reset!,
      `Go back to the commit before ${named(split)}: its changes stay in the working tree, uncommitted.`,
      [
        ['--mixed', 'keep the changes in the working tree, unstaged'],
        ['HEAD~1', 'the commit before it'],
      ],
    );
  } else {
    b.command(
      reset!,
      `Unstage the resolved changes of ${named(split)}: they stay in the working tree, uncommitted.`,
      [['--mixed', 'keep the changes in the working tree, unstaged']],
    );
  }
  b.notice(
    'info',
    'Then stage part of its changes and commit; repeat as needed. Continue commits whatever is left with the original message and author.',
  );
  b.split = step;
  return title;
}

/**
 * Continue, skip and abort while a history edit is stopped at a commit to split. Returns the
 * title when the step is planned here; otherwise the usual plan follows (with a word on the split).
 */
export async function planSplitControl(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'continue' | 'skip' | 'abort' }>,
  b: PlanBuilder,
): Promise<string | undefined> {
  const split = ctx.opState.split;
  if (!split) return undefined;
  if (op.kind === 'abort') {
    await planSplitAbort(ctx, split, b);
    // The usual abort follows (it saves the changes made since the stop first).
    return undefined;
  }
  if (!split.opened) {
    if (op.kind === 'continue' && ctx.opState.conflicts.length === 0)
      b.notice('info', `${named(split)} stays whole: choose Split first to commit it in parts.`);
    return undefined;
  }
  if (op.kind === 'skip') {
    b.block(
      `Skipping would leave out what is not committed of ${named(split)}. Continue commits it; Abort puts everything back.`,
    );
    return `Skip ${short(split.commit)}`;
  }
  return planFinishSplit(ctx, split, b);
}

/** Aborting while splitting: the commit's new files are tracked again first (git would not overwrite them). */
async function planSplitAbort(ctx: PlanContext, split: SplitState, b: PlanBuilder): Promise<void> {
  const parts = split.parts.length;
  if (parts > 0) {
    b.notice(
      'info',
      `${parts === 1 ? 'The part committed so far goes' : `The ${parts} parts committed so far go`} too: the history comes back as it was, with ${short(split.commit)} whole.`,
    );
  }
  if (!split.opened) return;
  const [paths, changes] = await Promise.all([changedPaths(ctx.repo, split.commit), ctx.worktreeChanges()]);
  const own = new Set(paths);
  const untracked = changes.untracked.map((file) => file.path).filter((path) => own.has(path));
  if (untracked.length === 0) return;
  const step: SplitStep = { step: 'abort', add: literalPathArgs(untracked) };
  const [add] = splitStepArgs(step);
  b.command(
    add!,
    `Track the new files of ${named(split)} again (${describePaths(untracked)}): git does not overwrite untracked files.`,
    addFlags(step.add),
  );
  b.split = step;
}

/** Continue while splitting: what is left of the commit becomes its last part, then the edit goes on. */
async function planFinishSplit(ctx: PlanContext, split: SplitState, b: PlanBuilder): Promise<string> {
  const title = `Finish splitting ${short(split.commit)}`;
  const paths = await changedPaths(ctx.repo, split.commit);
  const [changes, ignored] = await Promise.all([ctx.worktreeChanges(), ignoredFiles(ctx.repo, paths)]);
  const own = new Set(paths);
  // Both sides of a rename count; so do the commit's files that git ignores (added with -f).
  const unstaged = [...new Set(changes.unstaged.flatMap((file) => [file.path, file.oldPath ?? file.path]))];
  const left = [...new Set([...unstaged, ...changes.untracked.map((file) => file.path), ...ignored])].filter(
    (path) => own.has(path),
  );
  // Git cannot go on with unstaged changes to tracked files: these are not the commit's to finish.
  const elsewhere = unstaged.filter((path) => !own.has(path));
  const stray = changes.untracked.filter((file) => !own.has(file.path)).length;
  const stagedElsewhere = changes.staged.map((file) => file.path).filter((path) => !own.has(path));
  if (changes.conflicted.length > 0) b.block('Resolve the conflicts first.');
  if (elsewhere.length > 0) {
    const one = elsewhere.length === 1;
    b.block(
      `${describePaths(elsewhere)} changed too, but ${one ? 'is' : 'are'} not part of ${named(split)}: stage ${one ? 'it' : 'them'} to commit ${one ? 'it' : 'them'}, or put ${one ? 'it' : 'them'} back as ${one ? 'it was' : 'they were'}.`,
    );
  }

  const step: SplitStep = {
    step: 'finish',
    commit: split.commit,
    add:
      left.length > 0
        ? { ...literalPathArgs(left), force: ignored.some((path) => own.has(path)) || undefined }
        : undefined,
    commitRest: left.length > 0 || changes.staged.length > 0,
  };
  for (const args of splitStepArgs(step)) {
    if (args[0] === 'add') {
      b.command(args, `Stage what is left of ${named(split)}: ${describePaths(left)}.`, addFlags(step.add!));
    } else if (args[0] === 'commit') {
      b.command(args, `Commit it with the original message, author and date of ${short(split.commit)}.`, [
        ['-C', 'reuse the message, author and date of that commit'],
      ]);
    } else {
      b.command(args, 'Go on with the history edit.');
    }
  }
  // Continuing before any part is committed ends the split with the commit as it was.
  if (step.commitRest && split.parts.length === 0)
    b.notice('info', `No part is committed yet: ${named(split)} stays one commit, as it was.`);
  if (step.commitRest && stagedElsewhere.length > 0) {
    b.notice('info', `The staged changes to ${describePaths(stagedElsewhere)} go into it too.`);
  } else if (!step.commitRest && split.parts.length > 0) {
    b.notice(
      'info',
      `Nothing is left of ${named(split)}: its ${plural(split.parts.length, 'part')} replace it.`,
    );
  } else if (!step.commitRest) {
    b.notice(
      'warning',
      `Nothing is left of ${named(split)} and no part was committed: it disappears from the history.`,
    );
  }
  if (stray > 0) {
    b.notice(
      'info',
      `${plural(stray, 'new file')} that ${stray === 1 ? 'is' : 'are'} not part of it stay${stray === 1 ? 's' : ''} untracked.`,
    );
  }
  b.split = step;
  return title;
}

/**
 * A commit while splitting: the next part (the history edit goes on). Returns its title, or
 * undefined when no split is in progress.
 */
export function planSplitPart(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'commit' }>,
  b: PlanBuilder,
): string | undefined {
  const split = ctx.opState.split;
  if (!split?.opened) return undefined;
  b.duringStop = true;
  if (op.amend) {
    b.block(
      'Amending is not available while splitting a commit: commit the next part instead (and reword it later if needed).',
    );
    return `Amend a part of ${short(split.commit)}`;
  }
  return `Commit part ${split.parts.length + 1} of ${short(split.commit)}`;
}
