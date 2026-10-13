/*
 * Plans for linked worktrees: add, remove and prune.
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Operation } from '../../../shared/operations';
import { validateRefName } from '../../git/args';
import { readWorktrees } from '../../repo/worktrees';
import type { PlanBuilder, PlanContext } from '../planner';
import { findRef, plural, resolveCommit, short } from './common';

export async function planAddWorktree(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'addWorktree' }>,
  b: PlanBuilder,
) {
  const name = op.branch ?? op.newBranch;
  const title = name ? `Open ${name} in a new worktree` : 'New worktree';
  const folder = op.path.trim();
  if (!folder) {
    b.block('Choose a folder for the new worktree.', { field: 'path', missing: true });
    return title;
  }
  const full = resolvePath(ctx.repo.root, folder);
  if (existsSync(full) && readdirSync(full).length > 0)
    b.block(`${full} already exists and is not empty.`, { field: 'path' });
  const worktrees = await readWorktrees(ctx.repo);
  if (op.branch) {
    if (!findRef(ctx, op.branch, 'branch')) {
      b.block(`There is no branch named ${op.branch}.`, { final: true });
      return title;
    }
    const elsewhere = worktrees.find((tree) => tree.branch === op.branch);
    if (elsewhere) {
      b.block(`${op.branch} is already checked out in ${elsewhere.path}.`, { final: true });
      if (!elsewhere.current && !elsewhere.prunable) b.worktree = elsewhere.path;
    }
    b.command(['worktree', 'add', '--', folder, op.branch], `Check out ${op.branch} in “${full}”.`);
  } else if (op.newBranch) {
    const error = validateRefName(op.newBranch);
    if (error) b.block(`${error}.`, { field: 'newBranch' });
    else if (findRef(ctx, op.newBranch, 'branch'))
      b.block(`A branch named ${op.newBranch} already exists.`, { field: 'newBranch' });
    const at = await resolveCommit(ctx.repo, op.at ?? 'HEAD');
    if (!at) {
      b.block(`${op.at ?? 'HEAD'} is not a commit.`, { final: true });
      return title;
    }
    b.command(
      ['worktree', 'add', '-b', op.newBranch, '--', folder, at],
      `Create ${op.newBranch} at ${short(at)} and check it out in “${full}”.`,
      [['-b', 'create the branch']],
    );
  } else {
    if (op.newBranch !== undefined)
      b.block('Enter a name for the new branch.', { field: 'newBranch', missing: true });
    else b.block('Choose a branch to check out there.', { final: true });
    return title;
  }
  b.notice('info', 'The folder shares this repository: commits and branches made there show up here too.');
  return title;
}

export async function planRemoveWorktree(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'removeWorktree' }>,
  b: PlanBuilder,
) {
  const title = `Remove the worktree ${op.path}`;
  const tree = (await readWorktrees(ctx.repo)).find(
    (candidate) => resolvePath(candidate.path) === resolvePath(op.path),
  );
  if (!tree) {
    b.block(`${op.path} is not a worktree of this repository.`, { final: true });
    return title;
  }
  if (tree.main) b.block('The main worktree cannot be removed.', { final: true });
  else if (tree.current) b.block('This window has that worktree open.', { final: true });
  else if (tree.locked) b.block(`It is locked (${tree.locked}).`, { final: true });
  b.command(
    ['worktree', 'remove', '--', tree.path],
    `Delete the folder ${tree.path} and forget the worktree.`,
  );
  b.risk('Deletes a folder');
  b.notice(
    'warning',
    `The folder is deleted (git refuses while it has uncommitted changes or untracked files). ${tree.branch ? `The branch ${tree.branch} and its commits stay.` : 'Its commits stay.'}`,
  );
  // git deletes ignored files without asking (an .env, local settings): say which.
  if (!tree.prunable && existsSync(tree.path)) {
    const ignored = await ctx.repo
      .git(
        ['-C', tree.path, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
        {
          readOnly: true,
          background: true,
          okExitCodes: [0, 128],
        },
      )
      .then((result) => result.stdout.split('\0').filter(Boolean))
      .catch(() => []);
    if (ignored.length > 0) {
      const shown = ignored.slice(0, 5).join(', ');
      b.notice(
        'danger',
        `Ignored files are deleted with it, and Undo cannot bring them back: ${shown}${ignored.length > 5 ? `, and ${ignored.length - 5} more` : ''}.`,
      );
    }
  }
  return tree.branch ? `Remove the worktree of ${tree.branch}` : title;
}

export async function planPruneWorktrees(ctx: PlanContext, b: PlanBuilder) {
  const stale = (await readWorktrees(ctx.repo)).filter((tree) => tree.prunable);
  if (stale.length === 0) b.block('Every worktree still has its folder: nothing to prune.', { final: true });
  b.command(
    ['worktree', 'prune'],
    `Forget ${plural(stale.length, 'worktree')} whose folder${stale.length === 1 ? ' is' : 's are'} gone.`,
  );
  return 'Prune worktrees';
}
