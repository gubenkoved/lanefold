/*
 * What a rebase step that failed half-way left behind, and what stands in the way of an abort.
 *
 * A step git could not finish (a file it could not replace, say) leaves some of its changes in
 * the working tree and goes back on the todo. Before it runs again, is skipped, or the rebase is
 * aborted, those files have to go. A file that holds exactly what git wrote or had (the step's
 * version or the one before it) is simply put back: the next attempt writes it again. Anything
 * else in those files is someone's work, and is saved as a stash first.
 */

import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { filePaths, revisions } from '../git/args';
import type { Repository } from '../repo/repository';
import { describePaths } from '../util/wording';
import type { PlanBuilder } from './planner';

/** What to do with the files in the way (paths relative to the repository root). */
export interface Leftovers {
  /** Tracked before the step: back to HEAD's version, in the index and on disk. */
  readonly restore: readonly string[];
  /** New: out of the index and off the disk (git writes them again). */
  readonly remove: readonly string[];
  /** Holding something else (someone's edits): saved as a stash before anything else. */
  readonly save: readonly string[];
}

/** The object IDs a path has in each place (undefined: absent there). */
export interface PathVersions {
  readonly path: string;
  /** In HEAD (the last commit the rebase made). */
  readonly head?: string;
  /** In the commit of the failed step. */
  readonly step?: string;
  readonly index?: string;
  /** On disk ('dir' for a directory, which never matches a file's ID). */
  readonly disk?: string;
}

/** Sorts a path: untouched, put back (it holds git's own content) or saved (anything else). */
export function sortLeftover(versions: PathVersions): 'clean' | 'restore' | 'remove' | 'save' {
  const { head, step, index, disk } = versions;
  if (index === head && disk === head) return 'clean';
  const gits = (id: string | undefined) => id === head || id === step;
  if (!gits(index) || !gits(disk)) return 'save';
  return head === undefined ? 'remove' : 'restore';
}

/**
 * What the failed step `commit` left in the index and working tree. A revert writes the
 * versions of the commit's parent (`reverse`).
 */
export async function stepLeftovers(
  repo: Repository,
  commit: string,
  options: { readonly reverse?: boolean } = {},
): Promise<Leftovers> {
  const { stdout } = await repo.git(
    [
      'diff-tree',
      '-r',
      '-z',
      '--no-renames',
      '--no-commit-id',
      '--name-only',
      '--root',
      ...revisions(commit),
    ],
    { readOnly: true, background: true, label: 'Files of the failed step' },
  );
  const paths = stdout.split('\0').filter(Boolean);
  if (paths.length === 0) return { restore: [], remove: [], save: [] };
  const [head, step, index, disk] = await Promise.all([
    treeVersions(repo, 'HEAD', paths),
    // A root commit has no parent: reverting it removes its files.
    treeVersions(repo, options.reverse ? `${commit}^` : commit, paths),
    indexVersions(repo, paths),
    diskVersions(repo, paths),
  ]);
  const restore: string[] = [];
  const remove: string[] = [];
  const save: string[] = [];
  for (const path of paths) {
    const sorted = sortLeftover({
      path,
      head: head.get(path),
      step: step.get(path),
      index: index.has(path) ? index.get(path) : head.get(path),
      disk: disk.get(path),
    });
    if (sorted === 'restore') restore.push(path);
    else if (sorted === 'remove') remove.push(path);
    else if (sorted === 'save') save.push(path);
  }
  return { restore, remove, save };
}

/**
 * Untracked files an abort would have to overwrite with `target`'s version (git refuses):
 * removed when they hold that very version, saved otherwise.
 */
export async function abortBlockers(repo: Repository, target: string): Promise<Leftovers> {
  const { stdout } = await repo.git(['ls-files', '--others', '--exclude-standard', '-z'], {
    readOnly: true,
    background: true,
    label: 'Untracked files',
  });
  const untracked = stdout.split('\0').filter(Boolean);
  const inTarget = untracked.length > 0 ? await treeVersions(repo, target, untracked) : new Map();
  if (inTarget.size === 0) return { restore: [], remove: [], save: [] };
  const paths = [...inTarget.keys()];
  const disk = await diskVersions(repo, paths);
  return {
    restore: [],
    remove: paths.filter((path) => disk.get(path) === inTarget.get(path)),
    save: paths.filter((path) => disk.get(path) !== inTarget.get(path)),
  };
}

/** Both lists at once, each path once (saving wins over removing). */
export function mergeLeftovers(a: Leftovers, b: Leftovers): Leftovers {
  const save = [...new Set([...a.save, ...b.save])];
  const saved = new Set(save);
  const unique = (list: readonly string[]) => [...new Set(list)].filter((path) => !saved.has(path));
  return { restore: unique([...a.restore, ...b.restore]), remove: unique([...a.remove, ...b.remove]), save };
}

/** Paths for `--pathspec-from-file`: one per entry, never read as a pattern. */
export function pathspecList(paths: readonly string[]): Buffer {
  return Buffer.from(
    filePaths(...paths)
      .slice(1)
      .join('\0'),
  );
}

/** `git clean` takes paths as arguments only: a few at a time keeps command lines short. */
const CLEAN_BATCH = 100;

/**
 * Adds the commands that clear what is in the way: saved first (a stash), then put back from
 * HEAD, then the new files out of the index and off the disk.
 */
export function planLeftovers(b: PlanBuilder, leftovers: Leftovers, what: string): void {
  const { save, restore, remove } = leftovers;
  const fromStdin: [string, string][] = [
    ['--pathspec-from-file=-', 'the files, listed on standard input'],
    ['--pathspec-file-nul', 'one per entry, separated by NUL'],
  ];
  const these = (paths: readonly string[], one: string, many: string) => (paths.length === 1 ? one : many);
  if (save.length > 0) {
    b.stdin = { ...b.stdin, [b.commands.length]: pathspecList(save) };
    b.command(
      [
        'stash',
        'push',
        '--include-untracked',
        '--message',
        `Lanefold: changes in the way of ${what}`,
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      `Save your changes to ${describePaths(save)} as a stash first: ${these(save, 'it holds', 'they hold')} more than git wrote.`,
      [['--include-untracked', 'new files too'], ...fromStdin],
    );
  }
  if (restore.length > 0) {
    b.stdin = { ...b.stdin, [b.commands.length]: pathspecList(restore) };
    b.command(
      ['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
      `Put back ${describePaths(restore)} as ${these(restore, 'it was', 'they were')} before the step: git writes ${these(restore, 'it', 'them')} again.`,
      [
        ['--source=HEAD', 'the version of the last commit made'],
        ['--staged', 'in the index'],
        ['--worktree', 'and on disk'],
        ...fromStdin,
      ],
    );
  }
  if (remove.length > 0) {
    b.stdin = { ...b.stdin, [b.commands.length]: pathspecList(remove) };
    b.command(
      ['rm', '--cached', '--quiet', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'],
      `Unstage the new ${these(remove, 'file', 'files')} the step had written.`,
      [
        ['--cached', 'from the index only'],
        ['--ignore-unmatch', 'files that are not staged are fine'],
        ...fromStdin,
      ],
    );
    for (let start = 0; start < remove.length; start += CLEAN_BATCH) {
      const batch = remove.slice(start, start + CLEAN_BATCH);
      b.command(
        ['clean', '--force', '-x', '--quiet', ...filePaths(...batch)],
        `Remove ${describePaths(batch)}: git writes ${these(batch, 'it', 'them')} again.`,
        [
          ['--force', 'git refuses to delete files without it'],
          ['-x', 'even a file .gitignore lists'],
        ],
      );
    }
  }
}

/** Object IDs of `rev:path` for many paths at once (absent paths are missing). */
export async function treeVersions(
  repo: Repository,
  rev: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  return (await treeVersionsOf(repo, [rev], paths))[0]!;
}

/** {@link treeVersions} of several revisions in one go: a map for each, in their order. */
export async function treeVersionsOf(
  repo: Repository,
  revs: readonly string[],
  paths: readonly string[],
): Promise<Map<string, string>[]> {
  const found = revs.map(() => new Map<string, string>());
  // cat-file reads one name per line.
  const usable = paths.filter((path) => !/[\r\n]/.test(path));
  if (usable.length === 0 || revs.length === 0) return found;
  const { stdout } = await repo.git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    readOnly: true,
    background: true,
    label: 'File versions',
    stdin: revs.flatMap((rev) => usable.map((path) => `${rev}:${path}\n`)).join(''),
  });
  // One line for each name asked about, found or not.
  const lines = stdout.split('\n');
  revs.forEach((_, r) =>
    usable.forEach((path, p) => {
      const [object, type] = (lines[r * usable.length + p] ?? '').split(' ');
      if (type === 'blob' && object) found[r]!.set(path, object);
    }),
  );
  return found;
}

/** Object IDs of the staged versions that differ from HEAD (deleted ones are absent). */
export async function indexVersions(
  repo: Repository,
  paths: readonly string[],
): Promise<Map<string, string | undefined>> {
  const wanted = new Set(paths);
  const { stdout } = await repo.git(['diff-index', '--cached', '--raw', '-z', '--no-renames', 'HEAD'], {
    readOnly: true,
    background: true,
    label: 'Staged changes',
  });
  // ":old-mode new-mode old-id new-id status\0path\0"
  const fields = stdout.split('\0');
  const staged = new Map<string, string | undefined>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, , , id, status] = fields[i]!.split(' ');
    const path = fields[i + 1]!;
    if (wanted.has(path)) staged.set(path, status === 'D' || !id || /^0+$/.test(id) ? undefined : id);
  }
  return staged;
}

/** Object IDs of the files on disk, as git would store them (filters applied). */
export async function diskVersions(repo: Repository, paths: readonly string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const files: string[] = [];
  await Promise.all(
    paths.map(async (path) => {
      const full = join(repo.root, path);
      const stat = await lstat(full).catch(() => undefined);
      if (!stat) return;
      if (stat.isDirectory()) found.set(path, 'dir');
      else if (stat.isSymbolicLink())
        found.set(path, blobId(Buffer.from(await readlink(full)), repo.objectFormat));
      else if (stat.isFile()) files.push(path);
    }),
  );
  const hashable = files.filter((path) => !/[\r\n]/.test(path));
  if (hashable.length > 0) {
    const { stdout } = await repo.git(['hash-object', '--stdin-paths'], {
      readOnly: true,
      background: true,
      label: 'Files on disk',
      stdin: `${hashable.join('\n')}\n`,
    });
    stdout
      .split('\n')
      .filter(Boolean)
      .forEach((id, index) => found.set(hashable[index]!, id));
  }
  // A name git cannot take on a line: hashed here, unfiltered.
  for (const path of files.filter((path) => /[\r\n]/.test(path)))
    found.set(path, blobId(await readFile(join(repo.root, path)), repo.objectFormat));
  return found;
}

/** The ID git gives a blob with this content. */
function blobId(content: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format === 'sha256' ? 'sha256' : 'sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}

/** Whether all that is uncommitted is the step's own leftovers (nothing of anyone's to save). */
export async function onlyLeftovers(repo: Repository, leftovers: Leftovers): Promise<boolean> {
  if (leftovers.save.length > 0) return false;
  const ours = new Set([...leftovers.restore, ...leftovers.remove]);
  const { stdout } = await repo.git(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    {
      readOnly: true,
      background: true,
      label: 'Uncommitted changes',
    },
  );
  return stdout
    .split('\0')
    .filter(Boolean)
    .every((entry) => ours.has(entry.slice(3)));
}
