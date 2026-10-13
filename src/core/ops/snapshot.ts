import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isObjectId } from '../../shared/oid';
import type { WorkState } from '../../shared/operations';
import { filePaths } from '../git/args';
import { INTERNAL_IDENTITY } from '../git/identity';
import { emptyTree } from '../repo/repoData';
import type { Repository } from '../repo/repository';

/** Private ref whose reflog lists every safety snapshot (for recovery by hand). */
export const BACKUP_REF = 'refs/lanefold/backup';
/**
 * Snapshots an Undo may still need are kept by a ref each, under a folder per journal: reflog
 * entries alone expire (after 30 days for snapshots, which do not descend from one another).
 */
export const KEEP_REFS = 'refs/lanefold/keep';

/** Fixed identity for internal commits (snapshots), so they work without user.name/email. */

/**
 * Staging a working tree writes one object per new or changed file. With `core.fsync` covering
 * objects (as many setups have it), each is flushed to disk on its own: 20 seconds for 11,000
 * changed files. In batch mode git flushes them once, together — just as durable, five times
 * faster. (Older git ignores the setting.)
 */
const BATCH_FSYNC = ['-c', 'core.fsyncMethod=batch'];

async function git(repo: Repository, args: string[], env?: Record<string, string>, stdin?: string) {
  const result = await repo.git(args, { env, stdin, label: 'Safety snapshot', background: true });
  return result.stdout.trim();
}

/**
 * Records the working tree and index — including untracked (not ignored) files — as commits
 * on {@link BACKUP_REF}, before an operation that could lose them (reset --hard, discard).
 *
 * The snapshot commit's tree is the working tree; its parent's tree is the index; that
 * parent's parent is HEAD. Nothing in the working tree or the real index is touched: the
 * working tree is staged into a temporary copy of the index.
 */
export async function takeSnapshot(
  repo: Repository,
  reason: string,
  keep?: string,
  /** Ignored files to keep too (ones the operation overwrites). */
  include: readonly string[] = [],
): Promise<string> {
  const head = await repo.head();
  let indexTree: string;
  try {
    indexTree = await git(repo, ['write-tree']);
  } catch (error) {
    // Unmerged entries (a conflict) cannot be written as a tree: then HEAD's stands in for the
    // index (the working tree, conflict markers and resolutions included, is kept either way).
    // Any other failure (a lock held by another git) must not silently record the wrong index.
    if (!(await hasUnmergedEntries(repo))) throw error;
    indexTree = head.sha
      ? await git(repo, ['rev-parse', `${head.sha}^{tree}`])
      : emptyTree(repo.objectFormat);
  }
  const worktree = await worktreeTree(repo, include);
  const parents = head.sha ? ['-p', head.sha] : [];
  const indexCommit = await git(
    repo,
    ['commit-tree', '--no-gpg-sign', ...parents, '-F', '-', indexTree],
    INTERNAL_IDENTITY,
    `index before ${reason}\n`,
  );
  const snapshot = await git(
    repo,
    ['commit-tree', '--no-gpg-sign', '-p', indexCommit, '-F', '-', worktree],
    INTERNAL_IDENTITY,
    `lanefold: snapshot before ${reason}\n`,
  );
  await git(repo, [
    'update-ref',
    '--create-reflog',
    '-m',
    `lanefold: snapshot before ${reason}`,
    BACKUP_REF,
    snapshot,
  ]);
  if (keep) await git(repo, ['update-ref', `${KEEP_REFS}/${keep}/${snapshot}`, snapshot]);
  return snapshot;
}

async function hasUnmergedEntries(repo: Repository): Promise<boolean> {
  const { stdout } = await repo.git(['ls-files', '--unmerged', '-z'], {
    readOnly: true,
    background: true,
    label: 'Safety snapshot',
  });
  return stdout.length > 0;
}

/** Whether a snapshot commit is still in the repository (Undo needs it). */
export async function snapshotExists(repo: Repository, snapshot: string): Promise<boolean> {
  if (!isObjectId(snapshot)) return false;
  const result = await repo.git(['cat-file', '-e', `${snapshot}^{commit}`], {
    readOnly: true,
    background: true,
    label: 'Safety snapshot',
    okExitCodes: [0, 1, 128],
  });
  return result.exitCode === 0;
}

/**
 * Removes the keep-refs of a journal's snapshots that no journal entry needs any more (they
 * stay listed in the backup reflog until git expires them).
 */
export async function releaseSnapshots(
  repo: Repository,
  journal: string,
  needed: ReadonlySet<string>,
): Promise<void> {
  const folder = `${KEEP_REFS}/${journal}/`;
  const { stdout } = await repo.git(['for-each-ref', '--format=%(refname)', folder], {
    readOnly: true,
    background: true,
    label: 'Safety snapshot',
  });
  const stale = stdout
    .split('\n')
    .filter((ref) => ref.startsWith(folder) && !needed.has(ref.slice(folder.length)));
  if (stale.length === 0) return;
  await repo.git(['update-ref', '--stdin'], {
    stdin: `${stale.map((ref) => `delete ${ref}`).join('\n')}\n`,
    label: 'Safety snapshot',
    background: true,
  });
}

/**
 * Puts a snapshot on the stash list (as `stash@{0}`), so changes git is about to discard (an
 * aborted rebase's resolutions, say) stay one "apply" away. Returns the stash commit.
 */
export async function saveSnapshotAsStash(
  repo: Repository,
  snapshot: string,
  message: string,
): Promise<string> {
  // A stash is a commit of the working tree whose parents are HEAD and the index commit: the
  // snapshot already has that index commit (whose parent is HEAD).
  const [index, head] = (await git(repo, ['rev-parse', `${snapshot}^1`, `${snapshot}^1^1`])).split('\n');
  if (!index || !head) throw new Error('The snapshot has no HEAD to make a stash from.');
  const stash = await git(
    repo,
    ['commit-tree', '--no-gpg-sign', '-p', head, '-p', index, '-F', '-', `${snapshot}^{tree}`],
    INTERNAL_IDENTITY,
    `${message}\n`,
  );
  await git(repo, ['stash', 'store', '-m', message, stash]);
  return stash;
}

/**
 * The working tree as a tree object, untracked (not ignored) files included. The files are
 * staged into a temporary copy of the index; the real index is not touched.
 */
async function worktreeTree(repo: Repository, include: readonly string[] = []): Promise<string> {
  const tempIndex = join(tmpdir(), `lanefold-${randomUUID()}.index`);
  try {
    try {
      const index = repo.gitPath('index');
      await copyFile(index, tempIndex);
      // Keep the index's timestamp: git trusts an entry's stat data only when the entry is older
      // than the index file. A copy made now would make entries written in the same timestamp
      // tick look trustworthy, and a same-size edit made in that tick would go unseen.
      const { mtimeNs, atimeNs } = await stat(index, { bigint: true });
      await utimes(tempIndex, Number(atimeNs / 1000n) / 1e6, Number(mtimeNs / 1000n) / 1e6);
    } catch {
      // No index yet (fresh repository): start from an empty one.
    }
    const env = { ...INTERNAL_IDENTITY, GIT_INDEX_FILE: tempIndex };
    await git(repo, [...BATCH_FSYNC, 'add', '-A', '--', ':/'], env);
    const ignored = include.filter((path) => existsSync(join(repo.root, path)));
    if (ignored.length > 0) await git(repo, [...BATCH_FSYNC, 'add', '-f', ...filePaths(...ignored)], env);
    return await git(repo, ['write-tree'], env);
  } finally {
    await rm(tempIndex, { force: true });
  }
}

/** Fingerprints of the index and working tree right now (see {@link WorkState}). */
export async function readWorkState(repo: Repository): Promise<WorkState> {
  const [{ stdout }, worktree] = await Promise.all([
    repo.git(['ls-files', '--stage', '-z'], { readOnly: true, background: true, label: 'Read the index' }),
    worktreeTree(repo),
  ]);
  return { index: createHash('sha256').update(stdout).digest('hex'), worktree };
}

export function sameWorkState(a: WorkState | undefined, b: WorkState | undefined): boolean {
  return !!a && !!b && a.index === b.index && a.worktree === b.worktree;
}

/**
 * Puts the index and working tree back as a snapshot recorded them. The caller makes sure
 * HEAD is where it was when the snapshot was taken and that nothing would be overwritten.
 *
 * Only files that differ from the snapshot are written: rewriting every file would wake every
 * file watcher and rebuild everything in a large project, for an Undo that changed a few.
 */
export async function restoreSnapshot(repo: Repository, snapshot: string): Promise<void> {
  const options = { readOnly: true, background: true, label: 'Safety snapshot' } as const;
  const [diff, tree] = await Promise.all([
    // Decided before the index is replaced: its stat data tells unchanged files apart cheaply.
    // Without renames, a moved file counts as its two paths.
    repo.git(
      [
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        '--no-ext-diff',
        '--ignore-submodules=none',
        `${snapshot}^{tree}`,
        '--',
      ],
      options,
    ),
    repo.git(['ls-tree', '-r', '-z', '--name-only', `${snapshot}^{tree}`], options),
  ]);
  // Files the snapshot does not have are left alone, as before (callers remove them if needed).
  const inSnapshot = new Set(tree.stdout.split('\0'));
  const differing = diff.stdout.split('\0').filter((path) => path && inSnapshot.has(path));
  await git(repo, ['read-tree', `${snapshot}^1^{tree}`]);
  if (differing.length > 0) await writeFromTree(repo, `${snapshot}^{tree}`, differing);
}

/**
 * Writes these files of a tree into the working tree (the real index is not touched). Through
 * a temporary index and exact paths on stdin: thousands of pathspecs would each be matched
 * against every file.
 */
async function writeFromTree(repo: Repository, tree: string, paths: readonly string[]): Promise<void> {
  const tempIndex = join(tmpdir(), `lanefold-${randomUUID()}.index`);
  try {
    const env = { GIT_INDEX_FILE: tempIndex };
    await git(repo, ['read-tree', tree], env);
    await git(repo, ['checkout-index', '-f', '-z', '--stdin'], env, `${paths.join('\0')}\0`);
  } finally {
    await rm(tempIndex, { force: true });
  }
}

/**
 * Puts some files back as a snapshot recorded them (working tree only; the index is kept).
 * Files the snapshot does not have (they did not exist before) are removed.
 */
export async function restorePaths(
  repo: Repository,
  snapshot: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  const { stdout } = await repo.git(
    ['ls-tree', '-r', '-z', '--name-only', snapshot, ...filePaths(...paths)],
    {
      readOnly: true,
      background: true,
      label: 'Safety snapshot',
    },
  );
  const present = new Set(stdout.split('\0').filter(Boolean));
  const restore = paths.filter((path) => present.has(path));
  if (restore.length > 0)
    await git(repo, ['restore', `--source=${snapshot}`, '--worktree', ...filePaths(...restore)]);
  for (const path of paths) if (!present.has(path)) await rm(join(repo.root, path), { force: true });
}

/** A content hash of each file in the working tree (`null`: it does not exist). */
export async function fingerprintPaths(
  repo: Repository,
  paths: readonly string[],
): Promise<Record<string, string | null>> {
  const prints: Record<string, string | null> = {};
  for (const path of paths) {
    try {
      prints[path] = createHash('sha256')
        .update(await readFile(join(repo.root, path)))
        .digest('hex');
    } catch {
      prints[path] = null;
    }
  }
  return prints;
}

/**
 * Puts the index and working tree back exactly as `snapshot` recorded them, when they are now
 * exactly `after` (the caller checks): files that did not exist before are removed again.
 */
export async function restoreExact(repo: Repository, snapshot: string, after: WorkState): Promise<void> {
  await restoreSnapshot(repo, snapshot);
  const { stdout } = await repo.git(
    [
      'diff-tree',
      '-r',
      '-z',
      '--name-only',
      '--no-renames',
      '--diff-filter=A',
      `${snapshot}^{tree}`,
      after.worktree,
    ],
    { readOnly: true, background: true, label: 'Safety snapshot' },
  );
  const added = stdout.split('\0').filter(Boolean);
  // Only untracked files are cleaned: the restored index decides what is tracked.
  if (added.length > 0) await git(repo, ['clean', '-f', '-q', ...filePaths(...added)]);
}
