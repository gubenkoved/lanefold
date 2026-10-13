/*
 * Moving HEAD and refs back and forth for Undo and Redo, with what was staged staying staged.
 */

import type { RefState } from '../../shared/operations';
import { filePaths, revisions } from '../git/args';
import { GitError } from '../git/errors';
import type { Repository } from '../repo/repository';
import { putBackHalfDone } from './halfDone';
import { diskVersions, indexVersions, pathspecList, treeVersions } from './leftovers';
import { diffRefStates, headMoved } from './refState';

/** A staged path's index entry ("<mode> <oid> <stage>\t<path>"), to write back as it was. */
export interface StagedEntry {
  readonly path: string;
  readonly record: string;
}

/** The all-zeros object ID of the same format ("must not exist yet" in update-ref). */
function zeroOid(like: string): string {
  return '0'.repeat(like.length);
}

/**
 * Moves HEAD and refs from `current` to `target`:
 * 1. every ref except the checked-out branch in one atomic `update-ref --stdin` transaction
 *    that verifies each old value;
 * 2. HEAD (`git switch`), which refuses rather than overwrite local changes;
 * 3. the branch that stays checked out with `git reset --keep`, which also refuses rather
 *    than overwrite local changes.
 * If step 2 or 3 fails, step 1 is rolled back, and so is what git wrote before failing.
 * Returns what `git switch` printed (files it went on past, say).
 */
export async function moveRefs(
  repo: Repository,
  current: RefState,
  target: RefState,
  message: string,
  soft = false,
): Promise<string> {
  const checkedOut = current.branch ? `refs/heads/${current.branch}` : undefined;
  // Detached before and after: HEAD itself moves, the way a branch would (a commit made in
  // detached HEAD comes back as staged changes, like on a branch).
  const detachedMove = !current.branch && !target.branch && !!target.head && current.head !== target.head;
  const switching = headMoved(current, target) && !detachedMove;
  const staysCheckedOut = !switching && checkedOut;
  const changes = diffRefStates(current, target).filter(
    (change) => !(staysCheckedOut && change.ref === checkedOut),
  );
  // A ref that is checked out cannot be deleted before HEAD leaves it.
  const deletesCheckedOut = changes.find((change) => change.ref === checkedOut && !change.to);
  const early = changes.filter((change) => change !== deletesCheckedOut);

  const transaction = (list: typeof changes, reverse = false) =>
    `start\n${list
      .map(({ ref, from, to }) => {
        const [oldValue, newValue] = reverse ? [to, from] : [from, to];
        if (!newValue) return `delete ${ref} ${oldValue}`;
        return `update ${ref} ${newValue} ${oldValue ?? zeroOid(newValue)}`;
      })
      .join('\n')}\nprepare\ncommit\n`;
  const apply = (list: typeof changes, reverse = false) =>
    list.length === 0
      ? Promise.resolve()
      : repo.git(['update-ref', '-m', message, '--stdin'], {
          stdin: transaction(list, reverse),
          label: message,
        });

  await apply(early);
  let staged: string[] = [];
  let printed = '';
  try {
    if (switching) {
      if (target.head) staged = await stageAsTarget(repo, target.head, message);
      if (target.branch)
        printed = (
          await repo.git(['switch', '--no-guess', target.branch], {
            label: message,
            env: { GIT_REFLOG_ACTION: message },
          })
        ).stderr;
      else if (target.head)
        printed = (
          await repo.git(['switch', '--detach', target.head], {
            label: message,
            env: { GIT_REFLOG_ACTION: message },
          })
        ).stderr;
    } else if (staysCheckedOut) {
      const to = target.refs[checkedOut];
      if (to && to !== current.refs[checkedOut]) await resetKeepingStaged(repo, to, message, soft);
    } else if (detachedMove) {
      await resetKeepingStaged(repo, target.head!, message, soft);
    }
  } catch (error) {
    // Git gave up half-way, unable to replace a file (see halfDone): what it wrote goes back.
    if (error instanceof GitError && error.kind === 'fileInUse' && target.head)
      await putBackHalfDone(repo, { versions: [target.head], label: message }).catch(() => undefined);
    if (staged.length > 0)
      await repo
        .git(['restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          label: message,
          stdin: pathspecList(staged),
        })
        .catch(() => undefined);
    await apply(early, true).catch(() => undefined);
    throw error;
  }
  if (deletesCheckedOut) await apply([deletesCheckedOut]);
  return printed;
}

/**
 * Files that are as `target` has them, though the index moved on: ones git could not update
 * when HEAD last moved (a program held them open). Staged as they are, `git switch` has
 * nothing to write there, so it goes through (Undo of that move works, file held or not).
 * Returns the paths staged.
 */
async function stageAsTarget(repo: Repository, target: string, message: string): Promise<string[]> {
  const options = { readOnly: true, background: true, label: message } as const;
  const [unstaged, untracked, moving] = await Promise.all([
    repo.git(['diff', '--name-only', '-z', '--no-renames'], options),
    repo.git(['ls-files', '--others', '--exclude-standard', '-z'], options),
    repo.git(['diff-tree', '-r', '-z', '--name-only', '--no-renames', ...revisions('HEAD', target)], options),
  ]);
  const differs = new Set(moving.stdout.split('\0').filter(Boolean));
  const paths = [...unstaged.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(
    (path) => path && differs.has(path),
  );
  if (paths.length === 0) return [];
  const [head, there, staged, disk] = await Promise.all([
    treeVersions(repo, 'HEAD', paths),
    treeVersions(repo, target, paths),
    indexVersions(repo, paths),
    diskVersions(repo, paths),
  ]);
  const stale = paths.filter((path) => {
    const index = staged.has(path) ? staged.get(path) : head.get(path);
    return index === head.get(path) && disk.get(path) === there.get(path);
  });
  if (stale.length > 0)
    await repo.git(['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      label: message,
      stdin: pathspecList(stale),
    });
  return stale;
}

/**
 * `git reset --keep` (or `--soft`) to `to`, with what was staged still staged afterwards:
 * `--keep` refuses when a changed path differs between the two commits, and otherwise
 * unstages everything, so the staged paths' index entries are written back as they were.
 */
async function resetKeepingStaged(
  repo: Repository,
  to: string,
  message: string,
  soft: boolean,
): Promise<void> {
  const options = { label: message, env: { GIT_REFLOG_ACTION: message } };
  if (soft) {
    await repo.git(['reset', '--soft', to], options);
    return;
  }
  const staged = await stagedEntries(repo, message);
  await repo.git(['reset', '--keep', to], options);
  // The files are in the working tree either way; only their staging would be lost.
  await restage(repo, staged, message).catch(() => undefined);
}

/**
 * The index entries of the staged paths (index ≠ HEAD), for `update-index --index-info`; a
 * path staged for deletion becomes a removal.
 */
export async function stagedEntries(repo: Repository, label: string): Promise<StagedEntry[]> {
  const read = { readOnly: true, label } as const;
  const diff = await repo.git(['diff', '--cached', '--name-only', '-z', '--no-renames'], read);
  const paths = diff.stdout.split('\0').filter(Boolean);
  if (paths.length === 0) return [];
  const wanted = new Set(paths);
  // A long list of paths could exceed the command line: list the whole index then.
  const listed = await repo.git(
    ['ls-files', '-s', '-z', ...(paths.length <= 500 ? filePaths(...paths) : [])],
    read,
  );
  const entries: StagedEntry[] = [];
  let zero = '';
  for (const record of listed.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    const path = record.slice(tab + 1);
    if (tab < 0 || !wanted.has(path)) continue;
    wanted.delete(path);
    entries.push({ path, record });
    zero ||= zeroOid(record.split(' ')[1] ?? '');
  }
  for (const path of wanted) {
    zero ||= zeroOid((await repo.git(['rev-parse', 'HEAD'], read)).stdout.trim());
    entries.push({ path, record: `0 ${zero}\t${path}` });
  }
  return entries;
}

/** Writes index entries back (as noted by {@link stagedEntries}). */
async function restage(repo: Repository, entries: readonly StagedEntry[], label: string): Promise<void> {
  if (entries.length === 0) return;
  await repo.git(['update-index', '-z', '--index-info'], {
    label,
    stdin: `${entries.map((entry) => entry.record).join('\0')}\0`,
  });
}

/**
 * After an operation that set uncommitted changes aside (`--autostash`): stages again what was
 * staged, for the paths the operation did not change and git left unstaged.
 */
export async function restageAfterAutostash(
  repo: Repository,
  entries: readonly StagedEntry[],
  from: string | undefined,
  to: string | undefined,
  label: string,
): Promise<void> {
  const read = { readOnly: true, label } as const;
  const lines = (stdout: string) => new Set(stdout.split('\0').filter(Boolean));
  const changed =
    from && to && from !== to
      ? lines((await repo.git(['diff', '--name-only', '-z', '--no-renames', from, to], read)).stdout)
      : new Set<string>();
  const stagedNow = lines(
    (await repo.git(['diff', '--cached', '--name-only', '-z', '--no-renames'], read)).stdout,
  );
  await restage(
    repo,
    entries.filter((entry) => !changed.has(entry.path) && !stagedNow.has(entry.path)),
    label,
  );
}
