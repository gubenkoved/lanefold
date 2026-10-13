/*
 * Plans for checking out, creating, renaming, moving and deleting branches and tags, and reset.
 */

import { isObjectId } from '../../../shared/oid';
import type { Operation } from '../../../shared/operations';
import { revisions, validateRefName } from '../../git/args';
import type { PlanBuilder, PlanContext } from '../planner';
import {
  blockIfInWorktree,
  carryAround,
  commitName,
  commitTitle,
  describeDirty,
  describePaths,
  dirtyCount,
  findRef,
  isAncestor,
  orphanedBy,
  protectIgnored,
  resolveCommit,
  short,
  warnIfPublished,
} from './common';

/** Why a branch or tag name will not do, for the form field it was typed in. */
function nameProblem(name: string, what: string): string | undefined {
  if (name === '') return `Enter a name for the ${what}.`;
  const error = validateRefName(name);
  return error && `${error}.`;
}

/**
 * Uncommitted changes a switch from HEAD to `target` would overwrite, so git refuses it: tracked
 * files changed here that also differ there, and untracked files the target has.
 */
async function changesInTheWay(ctx: PlanContext, target: string): Promise<string[]> {
  const tree = ctx.workingTree;
  if (!ctx.head.sha || tree.staged + tree.unstaged + tree.untracked === 0) return [];
  const options = { readOnly: true, background: true, label: 'Changes in the way' } as const;
  const [changed, differing, untracked] = await Promise.all([
    ctx.repo.git(['diff', '--name-only', '-z', '--no-renames', 'HEAD'], options),
    ctx.repo.git(['diff', '--name-only', '-z', '--no-renames', ...revisions(ctx.head.sha, target)], options),
    tree.untracked > 0
      ? ctx.repo.git(['ls-files', '--others', '--exclude-standard', '-z'], options)
      : Promise.resolve({ stdout: '' }),
  ]);
  const paths = (text: string) => text.split('\0').filter(Boolean);
  const differs = new Set(paths(differing.stdout));
  return [...paths(changed.stdout), ...paths(untracked.stdout)].filter((path) => differs.has(path));
}

/**
 * Wraps the switch planned so far: when uncommitted changes are in its way, either says so (and
 * offers to carry them) or, asked to carry them, stashes them first and restores them after.
 */
async function carryChanges(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'checkout' }>,
  b: PlanBuilder,
  target: string,
  where: string,
): Promise<void> {
  const inTheWay = await changesInTheWay(ctx, target);
  if (inTheWay.length === 0) {
    if (dirtyCount(ctx.workingTree) + ctx.workingTree.untracked > 0)
      b.notice('info', `Your uncommitted changes come along to ${where} (nothing there is in their way).`);
    return;
  }
  const list = describePaths(inTheWay);
  if (!op.carry) {
    b.carryOver = { files: inTheWay };
    b.block(
      `Your uncommitted changes to ${list} would be overwritten by ${where}’s version. Carry them over, or commit or stash them first.`,
    );
    return;
  }
  if (ctx.workingTree.conflicted > 0) {
    b.block('Resolve the conflicts first.');
    return;
  }
  carryAround(
    ctx,
    b,
    `lanefold: carried to ${where}`,
    `Bring them back on ${where}, merged into its versions of ${list}.`,
    ctx.workingTree.untracked > 0,
  );
  b.notice(
    'info',
    `If your changes conflict with ${where}’s, git leaves conflict markers to resolve and keeps them on the stash list too. Undo puts everything back as it is now.`,
  );
}

export async function planCheckout(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'checkout' }>,
  b: PlanBuilder,
) {
  const local = op.detach ? undefined : findRef(ctx, op.target, 'branch');
  const remote = op.detach || local ? undefined : findRef(ctx, op.target, 'remote');
  if (local) {
    if (local.isHead) b.block(`${local.short} is already checked out.`, { final: true });
    // Checked out in another worktree: that is where to work on it (its files are there).
    const elsewhere = !local.isHead && (await blockIfInWorktree(ctx, b, local.short, CHECKED_OUT_ELSEWHERE));
    b.command(['switch', '--end-of-options', local.short], `Switch to the branch ${local.short}.`);
    b.changes.push({ ref: 'HEAD', from: ctx.head.branch ?? short(ctx.head.sha), to: local.short });
    await protectIgnored(ctx, b, ctx.head.sha, local.target);
    if (!local.isHead && !elsewhere) await carryChanges(ctx, op, b, local.target, local.short);
    return `Check out ${local.short}`;
  }
  if (remote) {
    const name = op.trackAs ?? remote.short.slice(remote.short.indexOf('/') + 1);
    const nameError = validateRefName(name);
    if (nameError) b.block(nameError);
    const existing = findRef(ctx, name, 'branch');
    if (existing) {
      const elsewhere = !existing.isHead && (await blockIfInWorktree(ctx, b, name, CHECKED_OUT_ELSEWHERE));
      b.command(['switch', '--end-of-options', name], `Switch to the local branch ${name}.`);
      if (!existing.isHead && !elsewhere) await carryChanges(ctx, op, b, existing.target, name);
      b.notice(
        'info',
        existing.target === remote.target
          ? `${name} already exists and matches ${remote.short}.`
          : `${name} already exists (at ${short(existing.target)}); ${remote.short} is at ${short(remote.target)}. Pull to update it.`,
      );
    } else {
      b.command(
        ['switch', '-c', name, '--track', remote.short],
        `Create the branch ${name} from ${remote.short} and switch to it.`,
        [
          ['-c', 'create a new branch'],
          ['--track', `set ${remote.short} as its upstream, so pull and push know where to go`],
        ],
      );
      b.changes.push({ ref: `refs/heads/${name}`, to: remote.target });
      await carryChanges(ctx, op, b, remote.target, name);
    }
    b.changes.push({ ref: 'HEAD', from: ctx.head.branch ?? short(ctx.head.sha), to: name });
    return `Check out ${remote.short}`;
  }
  const commit = await resolveCommit(ctx.repo, op.target);
  if (!commit) {
    b.block(`${op.target} is not a commit.`, { final: true });
    return `Check out ${op.target}`;
  }
  b.command(['switch', '--detach', commit], `Check out the commit ${short(commit)} itself.`, [
    ['--detach', 'no branch: HEAD points at the commit directly (“detached HEAD”)'],
  ]);
  await protectIgnored(ctx, b, ctx.head.sha, commit);
  if (commit !== ctx.head.sha) await carryChanges(ctx, op, b, commit, short(commit));
  b.notice(
    'info',
    'You will not be on a branch: new commits made there belong to none until you create one.',
  );
  b.changes.push({ ref: 'HEAD', from: ctx.head.branch ?? short(ctx.head.sha), to: short(commit) });
  // A tag (or another name) is named as given; a commit by its subject.
  return `Check out ${isObjectId(op.target) ? await commitTitle(ctx.repo, commit) : op.target}`;
}

const CHECKED_OUT_ELSEWHERE =
  'Git checks a branch out in one worktree at a time: open that one to work on it.';

export async function planCreateBranch(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'createBranch' }>,
  b: PlanBuilder,
) {
  const problem = nameProblem(op.name, 'branch');
  if (problem) b.block(problem, { field: 'name', missing: op.name === '' });
  else if (ctx.state.refs[`refs/heads/${op.name}`])
    b.block(`A branch named ${op.name} already exists.`, { field: 'name' });
  const commit = await resolveCommit(ctx.repo, op.at);
  if (!commit) b.block(`${op.at} is not a commit.`, { final: true });
  // Until a name is typed, the sheet says what will happen without one.
  const named = op.name !== '';
  if (op.checkout) {
    b.command(
      ['switch', '-c', op.name, commit ?? op.at],
      `Create ${named ? op.name : 'the branch'} at ${short(commit)} and switch to it.`,
      [['-c', 'create the branch before switching']],
    );
    if (named) b.changes.push({ ref: 'HEAD', from: ctx.head.branch ?? short(ctx.head.sha), to: op.name });
  } else {
    b.command(
      ['branch', op.name, commit ?? op.at],
      `Create the branch ${named ? `${op.name} ` : ''}at ${short(commit)}.`,
    );
  }
  if (named) b.changes.push({ ref: `refs/heads/${op.name}`, to: commit });
  return named ? `Create branch ${op.name}` : 'Create a branch';
}

export async function planDeleteBranch(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'deleteBranch' }>,
  b: PlanBuilder,
) {
  const ref = `refs/heads/${op.name}`;
  const tip = ctx.state.refs[ref];
  if (!tip) {
    b.block(`There is no branch named ${op.name}.`, { final: true });
    return `Delete branch ${op.name}`;
  }
  if (ctx.head.branch === op.name)
    b.block(`${op.name} is checked out. Switch to another branch first.`, { final: true });
  else
    await blockIfInWorktree(ctx, b, op.name, 'Switch that worktree to another branch, or remove it, first.');
  const keep = ctx.head.sha && ctx.head.branch !== op.name ? [ctx.head.sha] : [];
  const orphaned = await orphanedBy(ctx.repo, tip, op.name, keep);
  // git's rule for -d: merged into the branch's upstream if it has one, else into HEAD.
  const branchInfo = findRef(ctx, op.name, 'branch');
  const upstreamTip = branchInfo?.upstream ? findRef(ctx, branchInfo.upstream, 'remote')?.target : undefined;
  const mergedInto = upstreamTip ?? ctx.head.sha;
  const merged = mergedInto ? await isAncestor(ctx.repo, tip, mergedInto) : false;
  if (merged) {
    b.command(
      ['branch', '-d', '--end-of-options', op.name],
      upstreamTip
        ? `Delete ${op.name}; its commits are all in ${branchInfo!.upstream}.`
        : `Delete ${op.name}; its commits are all in the current branch.`,
      [['-d', 'delete only if fully merged (git refuses otherwise)']],
    );
  } else {
    b.command(['branch', '-D', '--end-of-options', op.name], `Delete ${op.name}.`, [
      [
        '-D',
        orphaned > 0
          ? 'delete even though some commits are on no other branch'
          : 'delete even though it is not merged into the current branch (its commits are kept by other branches)',
      ],
    ]);
  }
  if (orphaned > 0) {
    b.risk('Leaves commits behind');
    b.orphaned = orphaned;
    b.notice(
      'danger',
      `${orphaned} commit${orphaned === 1 ? ' is' : 's are'} only on ${op.name} and will no longer be on any branch. Undo brings the branch back.`,
    );
  }
  const branch = findRef(ctx, op.name, 'branch');
  if (branch?.upstream) b.notice('info', `The remote branch ${branch.upstream} is not deleted.`);
  b.changes.push({ ref, from: tip });
  return `Delete branch ${op.name}`;
}

export async function planRenameBranch(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'renameBranch' }>,
  b: PlanBuilder,
) {
  const tip = ctx.state.refs[`refs/heads/${op.from}`];
  if (!tip) b.block(`There is no branch named ${op.from}.`, { final: true });
  // The sheet opens with the current name: nothing to rename yet.
  const same = op.to === op.from;
  const problem = same ? `Enter a new name for ${op.from}.` : nameProblem(op.to, 'branch');
  if (problem) b.block(problem, { field: 'to', missing: same || op.to === '' });
  else if (ctx.state.refs[`refs/heads/${op.to}`])
    b.block(`A branch named ${op.to} already exists.`, { field: 'to' });
  // Until a new name is typed, the command shows where it goes (it cannot run like that).
  b.command(
    ['branch', '-m', '--end-of-options', op.from, same ? '' : op.to],
    `Rename ${op.from} to ${op.to && !same ? op.to : '…'} (its reflog and upstream come along).`,
    [['-m', 'move (rename) the branch']],
  );
  if (op.to && !same)
    b.changes.push({ ref: `refs/heads/${op.from}`, from: tip }, { ref: `refs/heads/${op.to}`, to: tip });
  return op.to && !same ? `Rename ${op.from} to ${op.to}` : `Rename ${op.from}`;
}

export async function planMoveBranch(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'moveBranch' }>,
  b: PlanBuilder,
) {
  const ref = `refs/heads/${op.name}`;
  const tip = ctx.state.refs[ref];
  const target = await resolveCommit(ctx.repo, op.to);
  if (!tip) b.block(`There is no branch named ${op.name}.`, { final: true });
  if (!target) b.block(`${op.to} is not a commit.`, { final: true });
  if (ctx.head.branch === op.name)
    b.block(`${op.name} is checked out: use Reset to move it.`, { final: true });
  else if (tip) await blockIfInWorktree(ctx, b, op.name, 'Move it there, with Reset.');
  if (tip && target && tip === target) b.block(`${op.name} is already at ${short(target)}.`, { final: true });
  b.command(
    ['branch', '--force', '--end-of-options', op.name, target ?? op.to],
    `Point ${op.name} at ${short(target)}.`,
    [['--force', 'move a branch that already exists']],
  );
  if (tip && target) {
    const orphaned = await orphanedBy(ctx.repo, tip, op.name, [target]);
    if (orphaned > 0) {
      b.risk('Leaves commits behind');
      b.orphaned = orphaned;
      b.notice(
        'warning',
        `${orphaned} commit${orphaned === 1 ? '' : 's'} will no longer be on any branch. Undo moves ${op.name} back.`,
      );
      await warnIfPublished(ctx, b, tip, target, op.name);
    } else if (await isAncestor(ctx.repo, tip, target)) {
      b.notice('info', `${op.name} moves forward (fast-forward): no commit leaves it.`);
    }
  }
  b.changes.push({ ref, from: tip, to: target });
  return `Move ${op.name} to ${(await commitName(ctx, target, op.name)) || op.to}`;
}

export async function planCreateTag(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'createTag' }>,
  b: PlanBuilder,
) {
  const problem = nameProblem(op.name, 'tag');
  if (problem) b.block(problem, { field: 'name', missing: op.name === '' });
  else if (ctx.state.refs[`refs/tags/${op.name}`])
    b.block(`A tag named ${op.name} already exists.`, { field: 'name' });
  const commit = await resolveCommit(ctx.repo, op.at);
  if (!commit) b.block(`${op.at} is not a commit.`, { final: true });
  const named = op.name !== '';
  const tag = named ? `${op.name} ` : '';
  if (op.message?.trim()) {
    b.command(
      ['tag', '-a', '-m', op.message.trim(), op.name, commit ?? op.at],
      `Create the annotated tag ${tag}at ${short(commit)}.`,
      [
        ['-a', 'annotated: records who tagged, when, and the message'],
        ['-m', 'the tag message'],
      ],
    );
  } else {
    b.command(['tag', op.name, commit ?? op.at], `Create the tag ${tag}at ${short(commit)}.`);
  }
  if (named) b.changes.push({ ref: `refs/tags/${op.name}`, to: commit });
  return named ? `Create tag ${op.name}` : 'Create a tag';
}

export async function planDeleteTag(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'deleteTag' }>,
  b: PlanBuilder,
) {
  const value = ctx.state.refs[`refs/tags/${op.name}`];
  if (!value) b.block(`There is no tag named ${op.name}.`, { final: true });
  b.command(['tag', '-d', op.name], `Delete the tag ${op.name} locally.`, [['-d', 'delete']]);
  if (ctx.refs.refs.some((ref) => ref.kind === 'remote')) {
    b.notice('info', 'If the tag was pushed, it stays on the remote.');
  }
  b.changes.push({ ref: `refs/tags/${op.name}`, from: value });
  return `Delete tag ${op.name}`;
}

const RESET_EXPLANATION: Record<string, [string, string]> = {
  soft: ['--soft', 'keep the index and working tree: the changes of the commits left behind become staged'],
  mixed: ['--mixed', 'reset the index but not the working tree: those changes become unstaged'],
  keep: ['--keep', 'update files that differ, but stop if that would overwrite local changes'],
  hard: [
    '--hard',
    'make the index and working tree match the target exactly, discarding uncommitted changes',
  ],
};

export async function planReset(ctx: PlanContext, op: Extract<Operation, { kind: 'reset' }>, b: PlanBuilder) {
  const target = await resolveCommit(ctx.repo, op.to);
  const head = ctx.head.sha;
  const name = ctx.head.branch ?? 'HEAD';
  b.action = `Reset ${name}`;
  if (!head) b.block('There is nothing to reset: the branch has no commits yet.', { final: true });
  if (!target) {
    b.block(`${op.to} is not a commit.`, { final: true });
    return `Reset ${name}`;
  }
  if (head === target && op.mode !== 'hard' && op.mode !== 'mixed')
    b.block(`${name} is already at ${short(target)}.`);
  b.command(['reset', `--${op.mode}`, target], `Move ${name} to ${short(target)}.`, [
    RESET_EXPLANATION[op.mode]!,
  ]);
  if (head) {
    const orphaned = await orphanedBy(ctx.repo, head, ctx.head.branch, [target]);
    if (orphaned > 0) {
      b.risk('Leaves commits behind');
      b.orphaned = orphaned;
      b.notice(
        'warning',
        `${orphaned} commit${orphaned === 1 ? '' : 's'} will no longer be on any branch. Undo moves ${name} back.`,
      );
      await warnIfPublished(ctx, b, head, target);
    }
  }
  const dirty = dirtyCount(ctx.workingTree);
  // A hard reset always keeps a snapshot: files saved after this plan was made are discarded
  // too, and Undo must bring them back.
  if (op.mode === 'hard') b.snapshot = true;
  // A mixed reset keeps the files but sets the index to the target: staged content that differs
  // from the files would be lost.
  if (op.mode === 'mixed' && ctx.workingTree.staged > 0) b.snapshot = true;
  if (op.mode === 'hard' || op.mode === 'keep')
    await protectIgnored(ctx, b, head, target, op.mode === 'hard');
  if (op.mode === 'hard' && (dirty > 0 || ctx.workingTree.untracked > 0)) {
    b.risk('Discards changes');
    b.notice(
      'danger',
      `Uncommitted changes (${describeDirty(ctx.workingTree)}) will be discarded. Lanefold saves a snapshot first, so Undo brings them back.`,
    );
  } else if (op.mode === 'keep' && dirty > 0) {
    b.notice(
      'info',
      'Your uncommitted changes are kept; git stops if a file you changed also differs at the target.',
    );
  }
  if (ctx.head.branch) b.changes.push({ ref: `refs/heads/${ctx.head.branch}`, from: head, to: target });
  else b.changes.push({ ref: 'HEAD', from: short(head), to: short(target) });
  return `Reset ${name} to ${await commitName(ctx, target, ctx.head.branch)}`;
}
