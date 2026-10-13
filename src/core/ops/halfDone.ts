/*
 * What git wrote before giving up half-way, put back.
 *
 * A file git cannot replace (on Windows, mostly one another program has open) fails a merge, a
 * pull, a cherry-pick, a reset or a stash after the files before it were written, and git leaves
 * those as they are. They would stand in the way of running the operation again ("your local
 * changes would be overwritten"), so Lanefold puts them back right away. A file is put back only
 * when it holds exactly what was there before or a version git was writing; anything else in it
 * (someone's edits) is left alone.
 */

import { rm, rmdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Operation } from '../../shared/operations';
import { isObjectId } from '../../shared/oid';
import { filePaths, revisions } from '../git/args';
import { filesInUse, type FileInUse } from '../git/errors';
import type { Repository } from '../repo/repository';
import { diskVersions, indexVersions, pathspecList, treeVersions, treeVersionsOf } from './leftovers';

export interface HalfDone {
  /** Files put back as they were. */
  readonly putBack: readonly string[];
  /** Files that changed but hold something git did not write: left as they are. */
  readonly left: readonly string[];
}

/** Past this many changed files, comparing them all is not worth it: they are left (and Undo). */
const MAX_PATHS = 20_000;

/**
 * Puts the files git changed before failing back as they were: as the safety `snapshot` taken
 * right before has them, else as HEAD has them (git only writes files that were clean). Only
 * files holding what was there before or a version of one of `versions` (commits or trees git
 * was writing) are touched. HEAD must not have moved.
 */
export async function putBackHalfDone(
  repo: Repository,
  options: {
    readonly snapshot?: string;
    readonly versions: readonly string[];
    readonly env?: Record<string, string>;
    readonly label: string;
  },
): Promise<HalfDone | undefined> {
  const { snapshot, versions, env, label } = options;
  const paths = await changedPaths(repo, snapshot);
  if (paths.length === 0) return { putBack: [], left: [] };
  if (paths.length > MAX_PATHS) return undefined;
  // The snapshot's tree is the working tree; its parent's, the index.
  const diskSource = snapshot ?? 'HEAD';
  const indexSource = snapshot ? `${snapshot}^1` : 'HEAD';
  const [head, diskBefore, indexBefore, staged, disk, written] = await Promise.all([
    treeVersions(repo, 'HEAD', paths),
    snapshot ? treeVersions(repo, diskSource, paths) : undefined,
    snapshot ? treeVersions(repo, indexSource, paths) : undefined,
    indexVersions(repo, paths),
    diskVersions(repo, paths),
    treeVersionsOf(repo, versions, paths),
  ]);
  const putBack: string[] = [];
  const left: string[] = [];
  const toIndex: string[] = [];
  const offIndex: string[] = [];
  const toDisk: string[] = [];
  const offDisk: string[] = [];
  for (const path of paths) {
    const before = { index: (indexBefore ?? head).get(path), disk: (diskBefore ?? head).get(path) };
    const now = { index: staged.has(path) ? staged.get(path) : head.get(path), disk: disk.get(path) };
    if (now.index === before.index && now.disk === before.disk) continue;
    // What git wrote, or had: absent counts too (a file git removed, or one it never had), and
    // so it does for a file git was rewriting (it removes the old one first, then writes).
    const here = written.map((version) => version.get(path));
    const rewriting = here.some((id) => id !== undefined && id !== head.get(path));
    const known = new Set([
      before.index,
      before.disk,
      head.get(path),
      ...here,
      ...(rewriting ? [undefined] : []),
    ]);
    if (!known.has(now.index) || !known.has(now.disk)) {
      left.push(path);
      continue;
    }
    putBack.push(path);
    if (now.index !== before.index) (before.index === undefined ? offIndex : toIndex).push(path);
    if (now.disk !== before.disk) (before.disk === undefined ? offDisk : toDisk).push(path);
  }
  const run = (args: string[], list: readonly string[]) =>
    repo.git(args, { env, label, stdin: pathspecList(list) });
  const fromStdin = ['--pathspec-from-file=-', '--pathspec-file-nul'];
  if (toIndex.length > 0)
    await run(['restore', `--source=${indexSource}`, '--staged', ...fromStdin], toIndex);
  if (offIndex.length > 0)
    await run(['rm', '--cached', '--quiet', '--ignore-unmatch', ...fromStdin], offIndex);
  if (toDisk.length > 0) await run(['restore', `--source=${diskSource}`, '--worktree', ...fromStdin], toDisk);
  for (const path of offDisk) await removeFile(repo.root, path);
  return { putBack, left };
}

/** How long to wait before each new try at files a program held (they are often held briefly). */
const STALE_RETRY_MS = [250, 1000];

/**
 * Files a command that went through could not replace (git named them in what it `printed`,
 * and went on: a switch does) and that still are as at `before` (the commit HEAD was on),
 * though the index has moved on. Programs often hold a file only for a moment, so they are
 * written again after a while, twice. Returns the ones still as before.
 */
export async function staleFiles(
  repo: Repository,
  printed: string,
  before: string | undefined,
  options: { readonly env?: Record<string, string>; readonly label: string },
): Promise<FileInUse[] | undefined> {
  const named = filesInUse(printed);
  if (named.length === 0) return undefined;
  let stale = await stillAsBefore(repo, named, before).catch(() => []);
  for (const wait of STALE_RETRY_MS) {
    if (stale.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, wait));
    const [tracked, untracked] = await trackedSplit(
      repo,
      stale.map((file) => file.path),
    );
    if (tracked.length > 0)
      await repo
        .git(['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          ...options,
          stdin: pathspecList(tracked),
        })
        .catch(() => undefined);
    // Files the index no longer has (git could not delete them).
    for (const path of untracked) await rm(join(repo.root, path), { force: true }).catch(() => undefined);
    stale = await stillAsBefore(repo, stale, before).catch(() => []);
  }
  return stale.length > 0 ? stale : undefined;
}

/** Of these files, the ones as they are at `before`, while the index has another version. */
async function stillAsBefore(
  repo: Repository,
  files: readonly FileInUse[],
  before: string | undefined,
): Promise<FileInUse[]> {
  const paths = files.map((file) => file.path);
  const [old, head, staged, disk] = await Promise.all([
    before ? treeVersions(repo, before, paths) : new Map<string, string>(),
    treeVersions(repo, 'HEAD', paths),
    indexVersions(repo, paths),
    diskVersions(repo, paths),
  ]);
  return files.filter(({ path }) => {
    const index = staged.has(path) ? staged.get(path) : head.get(path);
    return disk.get(path) !== index && disk.get(path) === old.get(path);
  });
}

/** These paths split into the ones in the index and the others. */
async function trackedSplit(repo: Repository, paths: readonly string[]): Promise<[string[], string[]]> {
  const { stdout } = await repo.git(['ls-files', '-z', '--cached', ...filePaths(...paths)], {
    readOnly: true,
    background: true,
    label: 'Tracked files',
  });
  const tracked = new Set(stdout.split('\0').filter(Boolean));
  return [paths.filter((path) => tracked.has(path)), paths.filter((path) => !tracked.has(path))];
}

/** Files that differ from HEAD now, or did when the snapshot was taken (untracked ones too). */
async function changedPaths(repo: Repository, snapshot: string | undefined): Promise<string[]> {
  const options = { readOnly: true, background: true, label: 'Uncommitted changes' } as const;
  const [status, ...before] = await Promise.all([
    repo.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], options),
    ...(snapshot
      ? [snapshot, `${snapshot}^1`].map((tree) =>
          repo.git(
            ['diff-tree', '-r', '-z', '--name-only', '--no-renames', ...revisions('HEAD', tree)],
            options,
          ),
        )
      : []),
  ]);
  const paths = new Set(
    status.stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3)),
  );
  for (const { stdout } of before) for (const path of stdout.split('\0')) if (path) paths.add(path);
  return [...paths];
}

/** Deletes a file, and the folders it leaves empty. */
async function removeFile(root: string, path: string): Promise<void> {
  await rm(join(root, path), { force: true });
  for (let dir = posix.dirname(path); dir !== '.' && dir !== '/'; dir = posix.dirname(dir)) {
    const removed = await rmdir(join(root, dir)).then(
      () => true,
      () => false,
    );
    // Not empty (or gone): the folders above are not empty either.
    if (!removed) break;
  }
}

/** Commits from `from` (exclusive) to HEAD, newest first (at most `limit`). */
async function commitsSince(repo: Repository, from: string, limit = 200): Promise<string[]> {
  const result = await repo.git(['rev-list', `--max-count=${limit}`, ...revisions(`${from}..HEAD`)], {
    readOnly: true,
    background: true,
    label: 'Commits',
    okExitCodes: [0, 128],
  });
  return result.exitCode === 0 ? result.stdout.split('\n').filter(isObjectId) : [];
}

/** The tree git's merge of `theirs` into `ours` comes to (it may hold conflict markers). */
async function mergedTree(repo: Repository, ours: string, theirs: string, base?: string): Promise<string[]> {
  const features = repo.runner.features;
  if (!features.mergeTreeWriteTree || (base && !features.mergeTreeMergeBase)) return [];
  const result = await repo.git(
    [
      'merge-tree',
      '--write-tree',
      '--no-messages',
      ...(base ? [`--merge-base=${base}`] : []),
      ...revisions(ours, theirs),
    ],
    { readOnly: true, background: true, label: 'Merge result', okExitCodes: [0, 1, 128] },
  );
  const tree = result.exitCode <= 1 ? result.stdout.split('\n')[0]?.trim() : undefined;
  return tree && isObjectId(tree) ? [tree] : [];
}

/**
 * The commits and trees whose files an operation writes: the ones a failure may have left half
 * written. (`head`: where HEAD was, and still is.)
 */
export async function writtenVersions(
  repo: Repository,
  operation: Operation,
  head: string,
): Promise<string[]> {
  switch (operation.kind) {
    case 'checkout':
      return [operation.target];
    case 'createBranch':
      return operation.checkout ? [operation.at] : [];
    case 'reset':
      return [operation.to];
    case 'merge':
      return [operation.source, ...(await mergedTree(repo, head, operation.source))];
    case 'pull':
      // Fetched first: what git merges or rebases onto is the upstream as fetched.
      return ['FETCH_HEAD', '@{upstream}', ...(await mergedTree(repo, head, 'FETCH_HEAD'))];
    case 'cherryPick': {
      const [only] = operation.commits;
      const merged =
        operation.commits.length === 1 && only ? await mergedTree(repo, head, only, `${only}^`) : [];
      return [...operation.commits, ...merged];
    }
    case 'revert': {
      const [only] = operation.commits;
      const merged =
        operation.commits.length === 1 && only ? await mergedTree(repo, head, `${only}^`, only) : [];
      return [...operation.commits.map((commit) => `${commit}^`), ...merged];
    }
    // A rebase checks out where it starts: what it replays onto, or (when the first commits
    // stay as they are) the last of those.
    case 'rebase':
      return [operation.onto, ...(await commitsSince(repo, operation.onto))];
    case 'rewrite':
      return [...(operation.base ? [operation.base] : []), ...operation.entries.map((entry) => entry.sha)];
    case 'amendInto':
      return [`${operation.commit}^`, ...(await commitsSince(repo, `${operation.commit}^`))];
    case 'stashApply': {
      const { stash } = operation;
      // Its working tree, index and untracked files, and what merging them in comes to.
      return [stash, `${stash}^2`, `${stash}^3`, ...(await mergedTree(repo, head, stash, `${stash}^1`))];
    }
    case 'restoreFiles':
      return [operation.source];
    case 'applyFileChanges':
      return [operation.commit, `${operation.commit}^`];
    default:
      // What else writes files writes HEAD's or the index's versions (a discard, a stash).
      return [];
  }
}
