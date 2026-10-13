/*
 * Plans for the working tree and the stash: commit, discard, restore, apply changes and patches,
 * identity.
 */

import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isLineSelection, linesLabel } from '../../../shared/hunks';
import type { StashEntry } from '../../../shared/models';
import type { Operation } from '../../../shared/operations';
import { cleanMessage } from '../../../shared/rewrite';
import { filePaths, revisions } from '../../git/args';
import type { LinePatch } from '../../repo/linePatch';
import { isFilePath, linePatchFor, patchBytes, readFileDiff, staleDiff } from '../../repo/lineStaging';
import { emptyTree } from '../../repo/repoData';
import { readStashList } from '../../repo/stash';
import type { PlanBuilder, PlanContext } from '../planner';
import {
  commitTitle,
  describeDirty,
  dirtyCount,
  fileName,
  filesLabel,
  ignoredOnDisk,
  parentsOf,
  plural,
  predictConflicts,
  resolveCommit,
  short,
  warnIfPublished,
} from './common';
import { planSplitPart } from './split';

/** Sets user.name and user.email: commits need them, and a new machine may have neither. */
export function planSetIdentity(op: Extract<Operation, { kind: 'setIdentity' }>, b: PlanBuilder) {
  const name = String(op.name ?? '').trim();
  const email = String(op.email ?? '').trim();
  if (!name) b.block('Enter your name.', { field: 'name', missing: true });
  else if (/[<>\n]/.test(name) || name.startsWith('-'))
    b.block('A name cannot start with “-” or contain < > or line breaks.', { field: 'name' });
  if (!email) b.block('Enter your email address.', { field: 'email', missing: true });
  else if (!/^[^\s@<>]+@[^\s@<>]+$/.test(email) || email.startsWith('-'))
    b.block('That does not look like an email address.', { field: 'email' });
  b.outcome = 'Saved your name and email';
  const scope = op.global ? ['--global'] : [];
  const flags: [string, string][] = op.global
    ? [['--global', 'in your own git settings, for every repository on this computer']]
    : [];
  b.command(['config', ...scope, 'user.name', name], `Sign commits as ${name || '…'}.`, flags);
  b.command(['config', ...scope, 'user.email', email], `With the email ${email || '…'}.`, flags);
  b.notice(
    'info',
    op.global
      ? 'This is saved in your git settings (~/.gitconfig) and applies to every repository on this computer.'
      : 'This is saved in this repository only (.git/config).',
  );
  return 'Set your name and email';
}

export async function planCommit(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'commit' }>,
  b: PlanBuilder,
) {
  const name = ctx.head.branch ?? 'HEAD';
  const head = ctx.head.sha;
  const message = cleanMessage(op.message);
  const tree = ctx.workingTree;
  if (tree.conflicted > 0) b.block('Resolve the conflicts first.');
  if (op.amend && !head) b.block('There is no commit to amend yet.');
  if (!op.amend && tree.staged === 0)
    b.block('Nothing is staged: stage the changes you want to commit first.');
  if (!op.amend && !message) b.block('Write a commit message.');
  const args = ['commit'];
  const flags: [string, string][] = [];
  if (op.amend) {
    args.push('--amend');
    flags.push(['--amend', 'replace the last commit with one that has the staged changes too']);
  }
  if (message) {
    args.push('-m', message);
    flags.push(['-m', 'the message']);
  } else {
    args.push('--no-edit');
    flags.push(['--no-edit', 'keep the last commit’s message']);
  }
  if (op.signoff) {
    args.push('--signoff');
    flags.push(['--signoff', 'add a “Signed-off-by” line with your name']);
  }
  const staged = plural(tree.staged, 'staged file');
  b.command(
    args,
    op.amend
      ? `Replace ${short(head)} with a commit that ${tree.staged > 0 ? `also has the ${staged}` : 'has the new message'}.`
      : `Record the ${staged} as a new commit on ${name}.`,
    flags,
  );
  if (op.amend && head) {
    b.risk('Rewrites a commit');
    b.notice('info', `${short(head)} gets a new hash. Undo puts it back.`);
    const [parent] = await parentsOf(ctx.repo, head);
    await warnIfPublished(ctx, b, head, parent);
  }
  if (tree.unstaged + tree.untracked > 0) {
    b.notice(
      'info',
      `Changes that are not staged (${describeDirty({ ...tree, staged: 0, conflicted: 0 })}) stay out of the commit.`,
    );
  }
  b.changes.push({
    ref: ctx.head.branch ? `refs/heads/${ctx.head.branch}` : 'HEAD',
    from: head,
    toNew: op.amend ? 'the amended commit' : 'a new commit',
  });
  return (
    planSplitPart(ctx, op, b) ??
    (op.amend ? `Amend ${head ? await commitTitle(ctx.repo, head) : 'the last commit'}` : `Commit to ${name}`)
  );
}

export async function planDiscard(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'discard' }>,
  b: PlanBuilder,
) {
  const changes = await ctx.worktreeChanges();
  // A submodule is no file to put back (updating it checks out the recorded commit again).
  const unstaged = new Set(changes.unstaged.filter((file) => !file.submodule).map((file) => file.path));
  const untracked = new Set(changes.untracked.map((file) => file.path));
  const tracked = op.paths.filter((path) => unstaged.has(path));
  const fresh = op.paths.filter((path) => untracked.has(path) && !unstaged.has(path));
  const count = tracked.length + fresh.length;
  const one = count === 1 ? (tracked[0] ?? fresh[0])! : undefined;
  const title = one
    ? `Discard changes to ${one.split('/').pop()}`
    : `Discard changes to ${plural(count, 'file')}`;
  if (count === 0) {
    b.block('Those files have no unstaged changes. (Staged changes are kept: unstage them first.)', {
      final: true,
    });
    return title;
  }
  if (tracked.length > 0) {
    b.command(
      ['restore', '--worktree', ...filePaths(...tracked)],
      `Put ${tracked.length === 1 ? tracked[0] : plural(tracked.length, 'file')} back as staged (or as last committed).`,
      [['--worktree', 'the files on disk only: what is staged stays staged']],
    );
  }
  if (fresh.length > 0) {
    b.command(
      ['clean', '-f', '-q', ...filePaths(...fresh)],
      `Delete ${fresh.length === 1 ? fresh[0] : plural(fresh.length, 'new file')} (not tracked by git yet).`,
      [['-f', 'really delete (git refuses without it)']],
    );
  }
  b.risk('Discards changes');
  b.snapshot = true;
  b.restorePaths = [...tracked, ...fresh];
  b.notice(
    'warning',
    `${count === 1 ? 'Its' : 'Their'} uncommitted changes are thrown away. Lanefold saves a snapshot first, so Undo brings them back.`,
  );
  return title;
}

/**
 * Throws away some of a file's unstaged changes: a patch of the selected lines, built from the
 * file's diff as it is (refused if that is not the diff that was shown), taken back out of the
 * file on disk. Undo restores the file from a snapshot.
 */
export async function planDiscardLines(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'discardLines' }>,
  b: PlanBuilder,
) {
  if (!isFilePath(op.path) || typeof op.fingerprint !== 'string' || !isLineSelection(op.selection)) {
    b.block('Choose the lines to discard.');
    return 'Discard lines';
  }
  const path = op.path;
  const name = fileName(path);
  const title = `Discard lines in ${name}`;
  const changes = await ctx.worktreeChanges();
  if (changes.untracked.some((file) => file.path === path)) {
    b.block(`${name} is not tracked by git yet: delete the file, or stage the lines to keep.`);
    return title;
  }
  if (!changes.unstaged.some((file) => file.path === path)) {
    b.block(`${name} has no unstaged changes. (Staged changes are kept: unstage them first.)`);
    return title;
  }
  let patch: LinePatch;
  try {
    patch = await linePatchFor(
      ctx.repo,
      { path, area: 'unstaged', fingerprint: op.fingerprint, selection: op.selection },
      true,
    );
  } catch (error) {
    b.block(error instanceof Error ? error.message : String(error));
    return title;
  }
  const count = patch.added + patch.removed;
  b.stdin = { [b.commands.length]: patchBytes(patch) };
  b.command(
    ['apply', '--reverse', '--whitespace=nowarn'],
    `Take ${count} changed line${count === 1 ? '' : 's'} out of ${path} on disk. Lanefold builds the patch from the selected lines (as git diff shows them), and git applies it in reverse.`,
    [
      ['--reverse', 'undo the patch: the selected changes come out of the file'],
      ['--whitespace=nowarn', 'take the lines exactly as they are (no whitespace fixes)'],
    ],
  );
  if (changes.staged.some((file) => file.path === path))
    b.notice('info', 'What is staged of it stays as it is.');
  b.notice(
    'warning',
    'Those changes are thrown away. Lanefold saves a snapshot first, so Undo brings them back.',
  );
  b.risk('Discards changes');
  b.snapshot = true;
  b.restorePaths = [path];
  // The review can take a while: the file must still be as it was when the patch was built.
  b.recheck = async () =>
    (await readFileDiff(ctx.repo, path, 'unstaged')).fingerprint === op.fingerprint
      ? undefined
      : staleDiff(path).message;
  b.doneMessage = `Taken out of ${name} on disk.`;
  return `Discard ${linesLabel(count)} in ${name}`;
}

export async function planRestoreFiles(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'restoreFiles' }>,
  b: PlanBuilder,
) {
  const paths = [...new Set(op.paths)];
  const source = await resolveCommit(ctx.repo, op.source);
  const title = `Restore ${filesLabel(paths)} from ${source ? short(source) : op.source}`;
  if (!source) {
    b.block(`${op.source} is not a commit.`);
    return title;
  }
  if (paths.length === 0) {
    b.block('Choose the files to restore.');
    return title;
  }
  const { stdout } = await ctx.repo.git(
    ['ls-tree', '-r', '-z', '--name-only', source, ...filePaths(...paths)],
    {
      readOnly: true,
      background: true,
    },
  );
  const existing = new Set(stdout.split('\0').filter(Boolean));
  const missing = paths.filter((path) => !existing.has(path));
  if (missing.length > 0) {
    b.block(`${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist in ${short(source)}.`);
    return title;
  }
  const changes = await ctx.worktreeChanges();
  const conflicted = new Set(changes.conflicted.map((file) => file.path));
  if (paths.some((path) => conflicted.has(path))) b.block('Resolve the conflicts in those files first.');
  const edited = new Set([...changes.unstaged, ...changes.untracked].map((file) => file.path));
  // Ignored files are not "changes", but they are someone's only copy.
  const ignored = await ignoredOnDisk(ctx.repo, paths);
  if (ignored.length > 0) b.snapshotIgnored = ignored;
  const overwritten = paths.filter((path) => edited.has(path) || ignored.includes(path));
  b.command(
    ['restore', `--source=${source}`, '--worktree', ...filePaths(...paths)],
    `Put ${paths.length === 1 ? paths[0] : plural(paths.length, 'file')} back as ${paths.length === 1 ? 'it was' : 'they were'} in ${short(source)}.`,
    [
      ['--source', `the version to take (${short(source)})`],
      ['--worktree', 'the files on disk only: nothing is staged'],
    ],
  );
  if (overwritten.length > 0) {
    b.risk('Replaces changes');
    b.notice(
      'warning',
      `Uncommitted changes to ${overwritten.length === 1 ? overwritten[0] : plural(overwritten.length, 'file')} are replaced. Lanefold saves a snapshot first, so Undo brings them back.`,
    );
  } else {
    b.notice('info', 'Undo puts the current version back.');
  }
  b.snapshot = true;
  b.restorePaths = paths;
  return title;
}

export async function planApplyFileChanges(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'applyFileChanges' }>,
  b: PlanBuilder,
) {
  const paths = [...new Set(op.paths)];
  const commit = await resolveCommit(ctx.repo, op.commit);
  const label = commit ? short(commit) : op.commit;
  const title = op.reverse
    ? `Revert ${label}’s changes to ${filesLabel(paths)}`
    : `Apply ${label}’s changes to ${filesLabel(paths)}`;
  if (!commit) {
    b.block(`${op.commit} is not a commit.`);
    return title;
  }
  if (!ctx.head.sha) {
    b.block('There is no commit to apply changes onto yet.');
    return title;
  }
  // Against the first parent (a root commit: against nothing).
  const parent = await resolveCommit(ctx.repo, `${commit}^`);
  const base = parent ?? emptyTree(ctx.repo.objectFormat);
  const { stdout } = await ctx.repo.git(
    ['diff', '--name-only', '-z', '--no-renames', ...revisions(base, commit), ...filePaths(...paths)],
    { readOnly: true, background: true },
  );
  const changed = stdout.split('\0').filter(Boolean);
  if (changed.length === 0) {
    b.block(`${short(commit)} does not change ${paths.length === 1 ? paths[0] : 'those files'}.`);
    return title;
  }
  const changes = await ctx.worktreeChanges();
  const conflicted = new Set(changes.conflicted.map((file) => file.path));
  if (changed.some((path) => conflicted.has(path))) b.block('Resolve the conflicts in those files first.');
  const unstaged = changes.unstaged.filter((file) => changed.includes(file.path)).map((file) => file.path);
  if (unstaged.length > 0)
    b.block(
      `${unstaged.join(', ')} ${unstaged.length === 1 ? 'has' : 'have'} unstaged changes: stage or stash them first (git applies the change to the index too).`,
    );
  b.command(
    [
      'diff',
      '--binary',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      ...revisions(base, commit),
      ...filePaths(...paths),
    ],
    `The changes ${short(commit)} made to ${changed.length === 1 ? changed[0] : plural(changed.length, 'file')}…`,
    [['--binary', 'binary files too']],
  );
  const apply = ['apply', '--3way'];
  const flags: [string, string][] = [
    ['--3way', 'merge where the files changed since, leaving conflict markers if needed'],
  ];
  if (op.reverse) {
    apply.push('--reverse');
    flags.push(['--reverse', 'take the changes back out']);
  }
  b.commands.push({
    args: apply,
    pipe: true,
    explanation: op.reverse
      ? '…taken back out of the working tree and the index.'
      : '…made to the working tree and the index.',
    flags: flags.map(([flag, meaning]) => ({ flag, meaning })),
  });
  b.notice('info', 'Nothing is committed. Undo puts the files back as they are now.');
  b.snapshot = true;
  b.exactUndo = true;
  return title;
}

export async function planApplyPatch(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'applyPatch' }>,
  b: PlanBuilder,
) {
  const name = fileName(op.file);
  const title = op.commit ? `Apply the commits in ${name}` : `Apply ${name}`;
  let isFile = false;
  try {
    isFile = isAbsolute(op.file) && statSync(op.file).isFile();
  } catch {
    // Missing: refused below.
  }
  if (!isFile) {
    b.block(`${op.file} is not a file.`);
    return title;
  }
  const numstat = await ctx.repo.git(['apply', '--numstat', '--', op.file], {
    readOnly: true,
    background: true,
    okExitCodes: [0, 1, 128],
  });
  const files = [
    ...new Set(
      numstat.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t')[2] ?? ''),
    ),
  ].filter(Boolean);
  if (numstat.exitCode !== 0 || files.length === 0) {
    b.block('That file is not a patch git understands.');
    return title;
  }
  const tree = ctx.workingTree;
  if (tree.conflicted > 0) b.block('Resolve the conflicts first.');
  if (op.commit) {
    const text = await readFile(op.file, 'utf8').catch(() => '');
    const commits = (text.match(/^From [0-9a-f]{40}(?:[0-9a-f]{24})? /gm) ?? []).length;
    if (commits === 0)
      b.block('There are no commits in that file (it is a plain diff): apply its changes instead.');
    if (!ctx.head.sha) b.block('There is no commit to apply them onto yet.');
    if (tree.staged > 0) b.block('Commit or unstage your staged changes first: git am needs a clean index.');
    b.command(
      ['am', '--3way', '--', op.file],
      `Recreate ${plural(commits, 'commit')} from ${name} on ${ctx.head.branch ?? 'HEAD'}, with their messages and authors.`,
      [['--3way', 'merge where the files changed since, stopping on conflicts']],
    );
    b.changes.push({
      ref: ctx.head.branch ? `refs/heads/${ctx.head.branch}` : 'HEAD',
      from: ctx.head.sha,
      toNew: plural(commits, 'new commit'),
    });
  } else {
    const changes = await ctx.worktreeChanges();
    const unstaged = changes.unstaged.filter((file) => files.includes(file.path)).map((file) => file.path);
    if (unstaged.length > 0)
      b.block(
        `${unstaged.join(', ')} ${unstaged.length === 1 ? 'has' : 'have'} unstaged changes: stage or stash them first (git applies the patch to the index too).`,
      );
    b.command(
      ['apply', '--3way', '--', op.file],
      `Apply the changes in ${name} to the working tree and the index; nothing is committed.`,
      [['--3way', 'merge where the files changed since, leaving conflict markers if needed']],
    );
    b.snapshot = true;
    b.exactUndo = true;
    b.notice('info', 'Undo puts the files back as they are now.');
  }
  b.notice(
    'info',
    `It changes ${files.length === 1 ? files[0] : `${plural(files.length, 'file')}: ${files.slice(0, 5).join(', ')}${files.length > 5 ? '…' : ''}`}.`,
  );
  return title;
}

/** "stash@{1} “message”", or "stash@{0} (WIP on main)" for git's own messages. */
function stashLabel(entry: StashEntry): string {
  const name = `stash@{${entry.index}}`;
  if (entry.generated) return `${name} (WIP on ${entry.branch ?? 'a detached HEAD'})`;
  const message = entry.message.length > 48 ? `${entry.message.slice(0, 47)}…` : entry.message;
  return `${name} “${message}”`;
}

async function findStash(ctx: PlanContext, sha: string, b: PlanBuilder): Promise<StashEntry | undefined> {
  const entry = (await readStashList(ctx.repo)).find((stash) => stash.sha === sha);
  if (!entry) b.block('That stash is no longer on the stash list.');
  return entry;
}

export function planStashPush(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'stashPush' }>,
  b: PlanBuilder,
) {
  const tree = ctx.workingTree;
  // A stash message is one line (it becomes the stash's reflog subject).
  const message = cleanMessage(op.message ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const paths = op.paths ?? [];
  const title = message
    ? `Stash “${message.length > 48 ? `${message.slice(0, 47)}…` : message}”`
    : 'Stash changes';
  if (!ctx.head.sha) b.block('There is nothing to stash on yet: make a first commit.');
  if (tree.conflicted > 0) b.block('Resolve the conflicts first: a stash cannot hold them.');
  if (op.stagedOnly) {
    if (!ctx.repo.runner.features.stashStaged)
      b.block('Stashing only staged changes needs git 2.35 or newer.');
    if (op.includeUntracked || op.keepIndex || paths.length > 0)
      b.block('Stashing only the staged changes cannot be combined with other options.');
    if (tree.staged === 0) b.block('Nothing is staged.');
  } else if (
    paths.length === 0 &&
    tree.staged + tree.unstaged === 0 &&
    !(op.includeUntracked && tree.untracked > 0)
  ) {
    b.block(
      tree.untracked > 0
        ? 'Only untracked files changed: include untracked files to stash them.'
        : 'There are no changes to stash.',
    );
  }
  const args = ['stash', 'push'];
  const flags: [string, string][] = [];
  if (message) {
    args.push('-m', message);
    flags.push(['-m', 'what the stash is (shown in the stash list)']);
  }
  if (op.stagedOnly) {
    args.push('--staged');
    flags.push(['--staged', 'only the staged changes']);
  }
  if (op.includeUntracked) {
    args.push('--include-untracked');
    flags.push(['--include-untracked', 'untracked files too (they are removed from the working tree)']);
  }
  if (op.keepIndex) {
    args.push('--keep-index');
    flags.push(['--keep-index', 'leave the staged changes in place (they are saved in the stash as well)']);
  }
  args.push(...filePaths(...paths));
  const what = op.stagedOnly
    ? `the ${plural(tree.staged, 'staged file')}`
    : paths.length > 0
      ? paths.length === 1
        ? paths[0]!
        : plural(paths.length, 'file')
      : 'your uncommitted changes';
  b.command(
    args,
    `Save ${what} on the stash list and take ${paths.length === 1 ? 'it' : 'them'} out of the working tree.`,
    flags,
  );
  if (!op.stagedOnly && !op.includeUntracked && paths.length === 0 && tree.untracked > 0)
    b.notice(
      'info',
      `${plural(tree.untracked, 'untracked file')} stay${tree.untracked === 1 ? 's' : ''} in place.`,
    );
  b.notice('info', 'Undo brings the changes back and removes the stash.');
  b.snapshot = true;
  b.exactUndo = true;
  b.stash = { creates: true };
  return title;
}

export async function planStashApply(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'stashApply' }>,
  b: PlanBuilder,
) {
  const entry = await findStash(ctx, op.stash, b);
  const verb = op.pop ? 'Pop' : 'Apply';
  if (!entry) return `${verb} stash`;
  const title = `${verb} ${stashLabel(entry)}`;
  const tree = ctx.workingTree;
  if (tree.conflicted > 0) b.block('Resolve the conflicts first.');
  const ref = `stash@{${entry.index}}`;
  const args = ['stash', op.pop ? 'pop' : 'apply'];
  const flags: [string, string][] = [];
  if (op.index) {
    args.push('--index');
    flags.push(['--index', 'also restore which changes were staged']);
  }
  args.push(ref);
  b.command(
    args,
    op.pop
      ? `Bring back the changes saved in ${ref} and remove it from the stash list (it stays there if they conflict).`
      : `Bring back the changes saved in ${ref}; it stays on the stash list.`,
    flags,
  );
  const head = ctx.head.sha;
  if (head && entry.base !== head) {
    b.notice(
      'info',
      `It was made on ${short(entry.base)}${entry.branch ? ` (${entry.branch})` : ''}: its changes are merged into ${ctx.head.branch ?? 'HEAD'} as it is now.`,
    );
  }
  if (dirtyCount(tree) + tree.untracked > 0) {
    b.notice('info', 'Your current changes stay. Git refuses if the stash would overwrite any of them.');
  } else if (head && entry.base !== head) {
    b.conflicts = await predictConflicts(ctx.repo, head, entry.sha, entry.base);
  }
  b.notice(
    'info',
    `Undo puts the working tree back as it is now${op.pop ? ', and the stash back on the list' : ''}.`,
  );
  b.snapshot = true;
  b.exactUndo = true;
  b.stash = { target: { index: entry.index, sha: entry.sha, subject: entry.subject }, removes: !!op.pop };
  return title;
}

export async function planStashDrop(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'stashDrop' }>,
  b: PlanBuilder,
) {
  const entry = await findStash(ctx, op.stash, b);
  if (!entry) return 'Drop stash';
  const ref = `stash@{${entry.index}}`;
  b.command(['stash', 'drop', ref], `Remove ${ref} from the stash list.`);
  b.risk('Drops a stash');
  b.notice('warning', 'Its changes are thrown away. Undo puts the stash back (at the top of the list).');
  b.stash = { target: { index: entry.index, sha: entry.sha, subject: entry.subject }, removes: true };
  return `Drop ${stashLabel(entry)}`;
}
