/*
 * Plans that bring commits onto the current branch or replay it: cherry-pick, revert, merge and
 * rebase.
 */

import { isObjectId } from '../../../shared/oid';
import type { Operation } from '../../../shared/operations';
import { revisions } from '../../git/args';
import type { PlanBuilder, PlanContext } from '../planner';
import {
  carryAround,
  commitName,
  commitTitle,
  count,
  describePaths,
  dirtyCount,
  isAncestor,
  oldestFirst,
  parentsOf,
  plural,
  predictConflicts,
  resolveAll,
  resolveCommit,
  revLabel,
  short,
  warnIfPublished,
} from './common';

/**
 * What stops git from applying commits (cherry-pick, revert) here: anything staged, as git wants
 * the index to match HEAD, or uncommitted changes to files the commits change. Unless they are
 * to be carried (set aside, then brought back), they block the plan, which offers to carry them.
 * Returns how to carry them when they are in the way and `carry` asks for it.
 */
async function changesInTheWayOfPicking(
  ctx: PlanContext,
  b: PlanBuilder,
  commits: readonly string[],
  action: 'cherry-picks' | 'reverts',
  carry: boolean,
): Promise<{ readonly untracked: boolean } | undefined> {
  const tree = ctx.workingTree;
  if (!ctx.head.sha || commits.length === 0 || tree.staged + tree.unstaged + tree.untracked === 0)
    return undefined;
  const options = { readOnly: true, background: true, label: 'Changes in the way' } as const;
  const none = Promise.resolve({ stdout: '' });
  const [touched, changed, staged, untracked] = await Promise.all([
    ctx.repo.git(
      [
        'log',
        '--no-walk=unsorted',
        '--format=',
        '--name-only',
        '-z',
        '-m',
        '--first-parent',
        ...revisions(...commits),
      ],
      options,
    ),
    tree.staged + tree.unstaged > 0
      ? ctx.repo.git(['diff', '--name-only', '-z', '--no-renames', 'HEAD'], options)
      : none,
    tree.staged > 0 ? ctx.repo.git(['diff', '--cached', '--name-only', '-z', '--no-renames'], options) : none,
    tree.untracked > 0 ? ctx.repo.git(['ls-files', '--others', '--exclude-standard', '-z'], options) : none,
  ]);
  const paths = (text: string) => text.split(/[\0\n]/).filter(Boolean);
  const changes = new Set(paths(touched.stdout));
  const newFiles = paths(untracked.stdout).filter((path) => changes.has(path));
  const inTheWay = [...paths(changed.stdout).filter((path) => changes.has(path)), ...newFiles];
  if (tree.staged === 0 && inTheWay.length === 0) return undefined;
  if (carry) return { untracked: newFiles.length > 0 };
  b.carryOver = { files: [...new Set([...paths(staged.stdout), ...inTheWay])] };
  b.block(
    tree.staged > 0
      ? `${plural(tree.staged, 'staged file')} ${tree.staged === 1 ? 'is' : 'are'} in the way: git ${action} only when nothing is staged. Carry your changes over, or commit or stash them first.`
      : `Your uncommitted changes to ${describePaths(inTheWay)} would be overwritten. Carry them over, or commit or stash them first.`,
  );
  return undefined;
}

/** Wraps a cherry-pick or revert planned so far so that the changes in its way come along. */
function carryPicking(
  ctx: PlanContext,
  b: PlanBuilder,
  carried: { readonly untracked: boolean },
  what: 'cherry-pick' | 'revert',
): void {
  carryAround(
    ctx,
    b,
    `lanefold: set aside for a ${what}`,
    'Bring your changes back, merged into the result.',
    carried.untracked,
  );
  b.notice(
    'info',
    `If git stops on a conflict, your changes wait on the stash list and come back once the ${what} is done or aborted. If they conflict with the result, git leaves conflict markers and keeps them on the stash list too. Undo puts everything back as it is now.`,
  );
}

/** How a merge or rebase names the commit it takes in: a name the user gave, or one at the commit. */
async function sourceLabel(ctx: PlanContext, rev: string, commit: string | undefined): Promise<string> {
  return isObjectId(rev) && commit ? commitName(ctx, commit, ctx.head.branch) : revLabel(rev);
}

export async function planCherryPick(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'cherryPick' }>,
  b: PlanBuilder,
) {
  const chosen = await oldestFirst(ctx.repo, await resolveAll(ctx, b, op.commits));
  const head = ctx.head.sha;
  const name = ctx.head.branch ?? 'HEAD';
  // Commits already in the branch would only stop the cherry-pick as empty: they are left out.
  const inBranch = head
    ? new Set(
        (await Promise.all(chosen.map(async (c) => ((await isAncestor(ctx.repo, c, head)) ? c : '')))).filter(
          Boolean,
        ),
      )
    : new Set<string>();
  const commits = chosen.filter((commit) => !inBranch.has(commit));
  let carried: { readonly untracked: boolean } | undefined;
  if (!head) b.block('Check out a branch with commits first.', { final: true });
  else if (chosen.length > 0 && commits.length === 0)
    b.block(
      `${chosen.length === 1 ? `${short(chosen[0])} is` : `All ${chosen.length} commits are`} already on ${name}: there is nothing to cherry-pick.`,
      { final: true },
    );
  else {
    if (inBranch.size > 0)
      b.notice(
        'info',
        `${plural(inBranch.size, 'commit')} already on ${name} ${inBranch.size === 1 ? 'is' : 'are'} left out.`,
      );
    carried = await changesInTheWayOfPicking(ctx, b, commits, 'cherry-picks', op.carry === true);
  }
  const merges = await Promise.all(commits.map(async (c) => (await parentsOf(ctx.repo, c)).length > 1));
  const flags: [string, string][] = [];
  const args = ['cherry-pick'];
  if (op.recordOrigin) {
    args.push('-x');
    flags.push(['-x', 'add “(cherry picked from commit …)” to each message']);
  }
  if (merges.some(Boolean)) {
    args.push('-m', '1');
    flags.push(['-m 1', 'for merge commits, apply the changes relative to their first parent']);
  }
  const shown = commits.length > 0 ? commits : chosen;
  b.command(
    [...args, ...shown],
    `Apply ${shown.length === 1 ? `${short(shown[0])}` : `${shown.length} commits, oldest first,`} on top of ${name}.`,
    flags,
  );
  if (carried) carryPicking(ctx, b, carried, 'cherry-pick');
  if (head) {
    if (commits.length === 1) {
      const [parent] = await parentsOf(ctx.repo, commits[0]!);
      if (parent) b.conflicts = await predictConflicts(ctx.repo, head, commits[0]!, parent);
    }
  }
  if (commits.length > 0)
    b.changes.push({
      ref: ctx.head.branch ? `refs/heads/${ctx.head.branch}` : 'HEAD',
      from: head,
      toNew: commits.length === 1 ? 'a new commit' : `${commits.length} new commits`,
    });
  return shown.length === 1
    ? `Cherry-pick ${await commitTitle(ctx.repo, shown[0])} onto ${name}`
    : `Cherry-pick ${shown.length} commits onto ${name}`;
}

export async function planRevert(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'revert' }>,
  b: PlanBuilder,
) {
  // Newest first: later changes are undone before the ones they build on.
  const commits = (await oldestFirst(ctx.repo, await resolveAll(ctx, b, op.commits))).reverse();
  const head = ctx.head.sha;
  let carried: { readonly untracked: boolean } | undefined;
  if (!head) b.block('Check out a branch with commits first.', { final: true });
  else carried = await changesInTheWayOfPicking(ctx, b, commits, 'reverts', op.carry === true);
  const merges = await Promise.all(commits.map(async (c) => (await parentsOf(ctx.repo, c)).length > 1));
  const flags: [string, string][] = [['--no-edit', 'use the default “Revert …” message']];
  const args = ['revert', '--no-edit'];
  if (merges.some(Boolean)) {
    args.push('-m', '1');
    flags.push(['-m 1', 'for merge commits, undo the changes the merged branch brought in']);
  }
  const name = ctx.head.branch ?? 'HEAD';
  b.command(
    [...args, ...commits],
    `Add ${commits.length === 1 ? 'a commit' : 'commits'} to ${name} that undo${commits.length === 1 ? 'es' : ''} the changes of ${commits.length === 1 ? short(commits[0]) : `${commits.length} commits, newest first`}.`,
    flags,
  );
  if (carried) carryPicking(ctx, b, carried, 'revert');
  if (head && commits.length === 1) {
    const [parent] = await parentsOf(ctx.repo, commits[0]!);
    if (parent && !merges[0]) b.conflicts = await predictConflicts(ctx.repo, head, parent, commits[0]);
  }
  b.changes.push({
    ref: ctx.head.branch ? `refs/heads/${ctx.head.branch}` : 'HEAD',
    from: head,
    toNew: commits.length === 1 ? 'a revert commit' : `${commits.length} revert commits`,
  });
  return commits.length === 1
    ? `Revert ${await commitTitle(ctx.repo, commits[0])}`
    : `Revert ${commits.length} commits`;
}

export async function planMerge(ctx: PlanContext, op: Extract<Operation, { kind: 'merge' }>, b: PlanBuilder) {
  const source = await resolveCommit(ctx.repo, op.source);
  const head = ctx.head.sha;
  const name = ctx.head.branch ?? 'HEAD';
  const label = await sourceLabel(ctx, op.source, source);
  if (!head) b.block('Check out a branch with commits first.', { final: true });
  if (!source) {
    b.block(`${label} is not a commit.`, { final: true });
    return `Merge ${label} into ${name}`;
  }
  if (head && (await isAncestor(ctx.repo, source, head))) {
    b.block(`${name} already contains ${label}: there is nothing to merge.`, { final: true });
    return `Merge ${label} into ${name}`;
  }
  // git resolves the name again when it runs (a fetch may have moved origin/main meanwhile).
  b.pinned.push({ rev: op.source, sha: source });
  const fastForward = head ? await isAncestor(ctx.repo, head, source) : false;
  const incoming = head ? await count(ctx.repo, revisions(source, `^${head}`)) : 0;
  const args = ['merge'];
  const flags: [string, string][] = [];
  switch (op.strategy) {
    case 'no-ff':
      args.push('--no-ff');
      flags.push(['--no-ff', 'always create a merge commit, even when a fast-forward is possible']);
      break;
    case 'ff-only':
      args.push('--ff-only');
      flags.push(['--ff-only', 'only fast-forward; stop if a merge commit would be needed']);
      if (!fastForward && head)
        b.block(`${name} and ${label} have diverged: a fast-forward is not possible.`);
      break;
    case 'squash':
      args.push('--squash');
      flags.push(['--squash', 'apply the combined changes as one new commit, without recording a merge']);
      break;
    case 'auto':
      break;
  }
  if (op.strategy !== 'squash' && op.strategy !== 'ff-only') {
    if (op.message?.trim()) {
      args.push('-m', op.message.trim());
      flags.push(['-m', 'the merge commit message']);
    } else {
      args.push('--no-edit');
      flags.push(['--no-edit', `use the default “Merge … into ${name}” message`]);
    }
  }
  b.command(
    [...args, op.source],
    `Bring the ${incoming} commit${incoming === 1 ? '' : 's'} of ${label} into ${name}.`,
    flags,
  );
  if (op.strategy === 'squash') {
    const message = op.message?.trim();
    b.command(message ? ['commit', '-m', message] : ['commit', '--no-edit'], 'Commit the squashed changes.', [
      message
        ? ['-m', 'the commit message']
        : ['--no-edit', 'use the prepared “Squashed commit of …” message'],
    ]);
  }
  if (fastForward && op.strategy === 'auto')
    b.notice('info', `${name} will simply move forward to ${label} (fast-forward, no merge commit).`);
  if (head && !fastForward) b.conflicts = await predictConflicts(ctx.repo, head, source);
  if (dirtyCount(ctx.workingTree) > 0) {
    b.notice('info', 'You have uncommitted changes. Git stops before merging if the merge would touch them.');
  }
  const ref = ctx.head.branch ? `refs/heads/${ctx.head.branch}` : 'HEAD';
  if (fastForward && op.strategy !== 'no-ff' && op.strategy !== 'squash')
    b.changes.push({ ref, from: head, to: source });
  else
    b.changes.push({
      ref,
      from: head,
      toNew: op.strategy === 'squash' ? 'a squashed commit' : 'a merge commit',
    });
  return `Merge ${label} into ${name}`;
}

export async function planRebase(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'rebase' }>,
  b: PlanBuilder,
) {
  const onto = await resolveCommit(ctx.repo, op.onto);
  const head = ctx.head.sha;
  const name = ctx.head.branch ?? 'HEAD';
  const label = await sourceLabel(ctx, op.onto, onto);
  if (!head) b.block('Check out a branch with commits first.', { final: true });
  if (!onto) {
    b.block(`${label} is not a commit.`, { final: true });
    return `Rebase ${name} onto ${label}`;
  }
  if (!ctx.head.branch) b.notice('info', 'HEAD is detached: the rebased commits will belong to no branch.');
  if (head && (await isAncestor(ctx.repo, onto, head))) {
    b.block(`${name} already contains ${label}: there is nothing to rebase.`, { final: true });
    return `Rebase ${name} onto ${label}`;
  }
  b.pinned.push({ rev: op.onto, sha: onto });
  const replay = head ? await count(ctx.repo, revisions(head, `^${onto}`)) : 0;
  const args = ['rebase'];
  const flags: [string, string][] = [];
  if (ctx.repo.runner.features.rebaseUpdateRefs) {
    args.push('--no-update-refs');
    flags.push(['--no-update-refs', 'leave other branches that point into this history alone']);
  }
  if (dirtyCount(ctx.workingTree) > 0) {
    args.push('--autostash');
    flags.push([
      '--autostash',
      'set your uncommitted changes aside during the rebase and restore them afterwards',
    ]);
  } else {
    args.push('--no-autostash');
  }
  b.command(
    [...args, op.onto],
    `Replay the ${replay} commit${replay === 1 ? '' : 's'} of ${name} on top of ${label}, one by one.`,
    flags,
  );
  if (replay > 0) {
    b.risk('Rewrites commits');
    b.notice(
      'info',
      `${replay === 1 ? 'The commit gets a new hash' : `The ${replay} commits get new hashes`}. Undo moves ${name} back to ${short(head)}.`,
    );
    if (head) await warnIfPublished(ctx, b, head, onto);
  }
  if (head) {
    const prediction = await predictConflicts(ctx.repo, head, onto);
    if (prediction?.predicted) b.conflicts = prediction;
  }
  b.changes.push({
    ref: ctx.head.branch ? `refs/heads/${ctx.head.branch}` : 'HEAD',
    from: head,
    ...(replay === 0 ? { to: onto } : { toNew: `${replay} rebased commit${replay === 1 ? '' : 's'}` }),
  });
  return `Rebase ${name} onto ${label}`;
}
