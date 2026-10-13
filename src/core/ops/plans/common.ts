/*
 * Helpers the planners share: naming commits, reading the history, wording.
 */

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { RefInfo, WorkingTreeSummary } from '../../../shared/models';
import type { OperationPlan } from '../../../shared/operations';
import { revisions } from '../../git/args';
import { count, resolveCommit } from '../../git/queries';
import type { Repository } from '../../repo/repository';
import { readWorktrees } from '../../repo/worktrees';
import { fileName, plural, short } from '../../util/wording';
import type { PlanBuilder, PlanContext } from '../planner';

// The plans' shared vocabulary, from where it lives.
export { displayRev as revLabel } from '../../../shared/oid';
export { count, isAncestor, resolveCommit } from '../../git/queries';
export { describePaths, fileName, plural, short } from '../../util/wording';

export const dirtyCount = (tree: WorkingTreeSummary) => tree.staged + tree.unstaged + tree.conflicted;

/**
 * Commits reachable from `tip` that no other branch, tag or remote-tracking branch holds (nor
 * anything reachable from `keep`): after the operation they would only be in the reflog.
 * `excludeBranch` is the (short) branch that is about to move or disappear.
 */
export async function orphanedBy(
  repo: Repository,
  tip: string,
  excludeBranch: string | undefined,
  keep: string[],
): Promise<number> {
  // --exclude matches the short name with --branches (and the full name in some versions).
  const exclude = excludeBranch
    ? [`--exclude=${excludeBranch}`, `--exclude=refs/heads/${excludeBranch}`]
    : [];
  return count(repo, [
    '--not',
    ...exclude,
    '--branches',
    '--tags',
    '--remotes',
    '--not',
    ...revisions(tip, ...keep.map((k) => `^${k}`)),
  ]);
}

/** Files git would stop on: `git merge-tree --write-tree` (git ≥ 2.38), never touches the tree. */
export async function predictConflicts(
  repo: Repository,
  ours: string,
  theirs: string,
  mergeBase?: string,
): Promise<OperationPlan['conflicts']> {
  const features = repo.runner.features;
  if (!features.mergeTreeWriteTree || (mergeBase && !features.mergeTreeMergeBase)) return undefined;
  const args = ['merge-tree', '--write-tree', '--name-only', '--no-messages'];
  if (mergeBase) args.push(`--merge-base=${mergeBase}`);
  const result = await repo.git([...args, ...revisions(ours, theirs)], {
    readOnly: true,
    background: true,
    label: 'Predict conflicts',
    okExitCodes: [0, 1, 128],
  });
  if (result.exitCode === 0) return { predicted: false, files: [] };
  if (result.exitCode !== 1) return undefined;
  const files = result.stdout.split('\n').slice(1).filter(Boolean);
  return { predicted: true, files };
}

export function findRef(ctx: PlanContext, name: string, kind?: RefInfo['kind']): RefInfo | undefined {
  return ctx.refs.refs.find((ref) => ref.short === name && (!kind || ref.kind === kind));
}

/** A commit's subject (the first line of its message), if it has one. */
export async function subjectOf(repo: Repository, commit: string): Promise<string | undefined> {
  const result = await repo.git(['log', '-1', '--format=%s', ...revisions(commit)], {
    readOnly: true,
    background: true,
    label: 'Commit subject',
    okExitCodes: [0, 128],
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

/** A subject as titles quote it: “Fix the parser”, shortened past 40 characters. */
export function quotedSubject(subject: string): string {
  return `“${subject.length > 40 ? `${subject.slice(0, 39)}…` : subject}”`;
}

/** How a title names a commit as a change: its subject in quotes (“Fix the parser”), else its short name. */
export async function commitTitle(repo: Repository, commit: string | undefined): Promise<string> {
  if (!commit) return '';
  const subject = await subjectOf(repo, commit);
  return subject ? quotedSubject(subject) : short(commit);
}

/**
 * How a title names a commit as a place: a branch there (else a tag, else a remote branch), else
 * its subject. `except`: a branch not to name it by (the one being moved).
 */
export async function commitName(
  ctx: PlanContext,
  commit: string | undefined,
  except?: string,
): Promise<string> {
  if (!commit) return '';
  const at = ctx.refs.refs.filter(
    (ref) => ref.target === commit && ref.short !== except && !ref.short.endsWith('/HEAD'),
  );
  const ref =
    at.find((candidate) => candidate.kind === 'branch') ??
    at.find((candidate) => candidate.kind === 'tag') ??
    at.find((candidate) => candidate.kind === 'remote');
  return ref ? ref.short : commitTitle(ctx.repo, commit);
}

/**
 * Blocks the plan when another worktree has `branch` checked out: git will not check it out
 * twice, move it or delete it under that worktree. `remedy` says what to do instead; opening
 * that worktree becomes the plan's way on. True when it blocked.
 */
export async function blockIfInWorktree(
  ctx: PlanContext,
  b: PlanBuilder,
  branch: string,
  remedy: string,
): Promise<boolean> {
  const tree = (await readWorktrees(ctx.repo).catch(() => [])).find(
    (candidate) => !candidate.current && candidate.branch === branch,
  );
  if (!tree) return false;
  if (tree.prunable) {
    b.block(
      `${branch} is checked out in a worktree whose folder is gone (${tree.path}). Prune worktrees first.`,
      { final: true },
    );
  } else {
    b.block(`${branch} is checked out in another worktree, ${tree.path}. ${remedy}`, { final: true });
    b.worktree = tree.path;
  }
  return true;
}

/**
 * Sets uncommitted changes aside around the commands planned so far: stashed first, back after,
 * merged into the result (what was staged staged again). `back` explains that last step; with
 * `untracked`, new files are set aside too. Undo puts the files back exactly as they are now.
 */
export function carryAround(
  ctx: PlanContext,
  b: PlanBuilder,
  message: string,
  back: string,
  untracked: boolean,
): void {
  const staged = ctx.workingTree.staged > 0;
  const pop = staged ? ['stash', 'pop', '--index'] : ['stash', 'pop'];
  const planned = b.commands.splice(0, b.commands.length);
  b.command(
    ['stash', 'push', ...(untracked ? ['--include-untracked'] : []), '-m', message],
    'Set your uncommitted changes aside on the stash list.',
    untracked ? [['--include-untracked', 'new files too (some are in the way)']] : [],
  );
  // A step that fails without stopping changed nothing: the changes come straight back.
  for (const command of planned) b.commands.push({ ...command, onFailure: pop });
  b.command(
    pop,
    back,
    staged ? [['--index', 'what was staged stays staged']] : [],
    // Staged changes that cannot be restored as staged come back unstaged.
    staged ? { fallback: ['stash', 'pop'] } : {},
  );
  b.snapshot = true;
  b.exactUndo = true;
  b.carries = true;
}

/** Warn when commits that would leave the current branch were already pushed. */
export async function warnIfPublished(
  ctx: PlanContext,
  b: PlanBuilder,
  removedFrom: string,
  /** Where the branch ends up (undefined: nothing of it stays, e.g. amending a root commit). */
  newTip: string | undefined,
  branchName = ctx.head.branch,
): Promise<void> {
  const branch = branchName ? findRef(ctx, branchName, 'branch') : undefined;
  const upstream = branch?.upstream ? findRef(ctx, branch.upstream, 'remote') : undefined;
  if (!upstream) return;
  const kept = newTip ? [`^${newTip}`] : [];
  const published = await count(ctx.repo, [...revisions(removedFrom, ...kept, `^${upstream.target}`)]).then(
    async (unpublished) => (await count(ctx.repo, revisions(removedFrom, ...kept))) - unpublished,
  );
  if (published > 0) {
    b.notice(
      'warning',
      `${published === 1 ? '1 commit that leaves' : `${published} commits that leave`} ${branchName} ${published === 1 ? 'is' : 'are'} already on ${upstream.short}. Publishing the result will need a force push (Lanefold uses --force-with-lease).`,
    );
  }
}

export function describeDirty(tree: WorkingTreeSummary): string {
  const parts = [
    tree.conflicted ? `${tree.conflicted} conflicted` : '',
    tree.staged ? `${tree.staged} staged` : '',
    tree.unstaged ? `${tree.unstaged} modified` : '',
    tree.untracked ? `${tree.untracked} untracked` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

export async function parentsOf(repo: Repository, commit: string): Promise<string[]> {
  const { stdout } = await repo.git(['rev-list', '--parents', '-n', '1', ...revisions(commit)], {
    readOnly: true,
    background: true,
  });
  return stdout.trim().split(' ').slice(1);
}

export async function resolveAll(
  ctx: PlanContext,
  b: PlanBuilder,
  revs: readonly string[],
): Promise<string[]> {
  const commits: string[] = [];
  for (const rev of revs) {
    const commit = await resolveCommit(ctx.repo, rev);
    if (commit) commits.push(commit);
    else b.block(`${rev} is not a commit.`, { final: true });
  }
  if (commits.length === 0) b.block('No commits selected.', { final: true });
  return commits;
}

/** Orders commits oldest first (by ancestry; unrelated ones keep their given order). */
export async function oldestFirst(repo: Repository, commits: string[]): Promise<string[]> {
  if (commits.length < 2) return commits;
  const { stdout } = await repo.git(
    ['rev-list', '--topo-order', '--reverse', '--no-walk=sorted', ...revisions(...commits)],
    {
      readOnly: true,
      background: true,
    },
  );
  const order = stdout.split('\n').filter(Boolean);
  return order.length === commits.length ? order : commits;
}

/** "forecast.ts", or "3 files". */
export function filesLabel(paths: readonly string[]): string {
  return paths.length === 1 ? fileName(paths[0]!) : plural(paths.length, 'file');
}

/** Of these paths, the ones on disk that git ignores (and so overwrites without asking). */
export async function ignoredOnDisk(repo: Repository, paths: readonly string[]): Promise<string[]> {
  const present = paths.filter((path) => existsSync(resolvePath(repo.root, path)));
  if (present.length === 0) return [];
  const result = await repo.git(['check-ignore', '-z', '--stdin'], {
    readOnly: true,
    background: true,
    stdin: `${present.join('\0')}\0`,
    okExitCodes: [0, 1],
  });
  return result.stdout.split('\0').filter(Boolean);
}

/**
 * Ignored files that moving the working tree from `from` to `to` overwrites (files `to` tracks
 * that are ignored here): a snapshot keeps them, and Undo puts them back.
 */
export async function protectIgnored(
  ctx: PlanContext,
  b: PlanBuilder,
  from: string | undefined,
  to: string,
  full = false,
) {
  if (!from || from === to) return;
  const { stdout } = await ctx.repo.git(
    ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=A', ...revisions(from, to)],
    { readOnly: true, background: true },
  );
  const ignored = await ignoredOnDisk(ctx.repo, stdout.split('\0').filter(Boolean));
  if (ignored.length === 0) return;
  b.risk('Replaces ignored files');
  b.snapshot = true;
  b.snapshotIgnored = ignored;
  // A full snapshot (hard reset) restores everything; otherwise only these files come back.
  if (!full) b.restorePaths = ignored;
  b.notice(
    'warning',
    `${ignored.length === 1 ? ignored[0] : plural(ignored.length, 'ignored file')} ${ignored.length === 1 ? 'is ignored here but tracked there, so git replaces it' : 'are tracked there, so git replaces them'}. Lanefold saves ${ignored.length === 1 ? 'it' : 'them'} first, so Undo brings ${ignored.length === 1 ? 'it' : 'them'} back.`,
  );
}
