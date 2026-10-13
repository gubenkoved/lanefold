import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangedFile, SubmoduleInfo, SubmoduleState } from '../../shared/models';
import type { OpState, SubmoduleConflict } from '../../shared/operations';
import { redactCredentials } from '../../shared/shell';
import { filePaths } from '../git/args';
import { parseStatus, type StatusResult } from '../parsers/status';
import {
  isSafeSubmodulePath,
  parseConfigValues,
  parseGitlinkConflicts,
  parseGitlinks,
  parseSubmoduleConfig,
  resolveSubmoduleUrl,
  type GitmodulesEntry,
} from '../parsers/submodules';
import { paths } from '../util/paths';
import type { Repository } from './repository';
import { readWorktrees } from './worktrees';

const READ = { readOnly: true, background: true, label: 'Submodules' } as const;

/**
 * The submodules .gitmodules declares (in the working tree, as `git submodule` reads it), with
 * usable paths only. No .gitmodules, no git process: most repositories have none.
 */
export async function readGitmodules(repo: Repository): Promise<GitmodulesEntry[]> {
  if (!existsSync(join(repo.root, '.gitmodules'))) return [];
  const result = await repo
    .git(['config', '--file', '.gitmodules', '-z', '--get-regexp', '^submodule\\.'], {
      ...READ,
      okExitCodes: [0, 1],
    })
    .catch(() => undefined);
  return parseSubmoduleConfig(result?.stdout ?? '').filter((entry) => isSafeSubmodulePath(entry.path));
}

/** Whether a submodule's folder holds its checkout (a `.git` file or folder). */
function populated(repo: Repository, path: string): boolean {
  return existsSync(join(repo.root, path, '.git'));
}

/** Runs a read-only git command inside a checked-out submodule. */
export function gitInSubmodule(repo: Repository, path: string, args: readonly string[], okExitCodes = [0]) {
  return repo.runner.run({ cwd: join(repo.root, path), args, ...READ, okExitCodes });
}

/** The commit checked out in a submodule's folder (undefined when it is not checked out). */
export async function submoduleHead(repo: Repository, path: string): Promise<string | undefined> {
  // Without its own .git, git would find this repository's HEAD instead.
  if (!populated(repo, path)) return undefined;
  const result = await gitInSubmodule(
    repo,
    path,
    ['rev-parse', '-q', '--verify', 'HEAD^{commit}'],
    [0, 1, 128],
  ).catch(() => undefined);
  return result?.exitCode === 0 ? result.stdout.trim() : undefined;
}

/** The branch HEAD is on, from the HEAD file (undefined when detached). */
async function headBranch(repo: Repository): Promise<string | undefined> {
  const text = await readFile(repo.gitPath('HEAD'), 'utf8').catch(() => '');
  return /^ref: refs\/heads\/(.+)$/m.exec(text)?.[1]?.trim();
}

/**
 * What this repository's settings say about its submodules: the URL each was initialized with
 * (initialized ones only), and the URL relative ones in .gitmodules are taken from (the current
 * branch's remote, else origin's, else this repository's own folder), as `git submodule` does.
 */
async function readSubmoduleSettings(repo: Repository) {
  const [config, branch] = await Promise.all([
    repo
      .git(
        ['config', '-z', '--get-regexp', '^(submodule\\..*\\.url|remote\\..*\\.url|branch\\..*\\.remote)$'],
        {
          ...READ,
          okExitCodes: [0, 1],
        },
      )
      .catch(() => undefined),
    headBranch(repo),
  ]);
  const values = parseConfigValues(config?.stdout ?? '');
  const remote = (branch && values.get(`branch.${branch}.remote`)) || 'origin';
  return {
    urlOf: (name: string) => values.get(`submodule.${name}.url`),
    base: values.get(`remote.${remote}.url`) ?? repo.root.replace(/\\/g, '/'),
  };
}

/** A URL as compared: forward slashes, no trailing one. */
const comparable = (url: string) => url.replace(/\\/g, '/').replace(/\/+$/, '');

/** The repository's submodules: declared, recorded in the index, and how their folders stand. */
export async function readSubmodules(repo: Repository): Promise<SubmoduleInfo[]> {
  const declared = await readGitmodules(repo);
  if (declared.length === 0) return [];
  const where = [...new Set(declared.map((entry) => entry.path!))];
  const [index, status, settings] = await Promise.all([
    repo.git(['ls-files', '--stage', '-z', ...filePaths(...where)], READ),
    // The submodules' real state, whatever `ignore` settings say.
    repo.git(
      [
        'status',
        '--porcelain=v2',
        '-z',
        '--ignore-submodules=none',
        '--untracked-files=no',
        ...filePaths(...where),
      ],
      READ,
    ),
    readSubmoduleSettings(repo),
  ]);
  const links = parseGitlinks(index.stdout);
  const changes = new Map(parseStatus(status.stdout).entries.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  const list = await Promise.all(
    declared.map(async (entry): Promise<SubmoduleInfo | undefined> => {
      const path = entry.path!;
      const link = links.get(path);
      // Declared, but not (or no longer) recorded in the index: not a submodule here.
      if (!link || seen.has(path)) return undefined;
      seen.add(path);
      const change = changes.get(path);
      const flags = change?.submodule;
      const checkedOut = !populated(repo, path)
        ? undefined
        : flags?.commitChanged
          ? await submoduleHead(repo, path)
          : link.oid;
      // Initialized: this repository's settings have its URL (deinit removes it again).
      const settingsUrl = settings.urlOf(entry.name);
      const state: SubmoduleState = link.conflicted
        ? 'conflicted'
        : !populated(repo, path)
          ? settingsUrl === undefined
            ? 'uninitialized'
            : 'missing'
          : flags?.commitChanged
            ? 'otherCommit'
            : flags?.modified || flags?.untracked
              ? 'dirty'
              : 'upToDate';
      const url = entry.url ? (resolveSubmoduleUrl(entry.url, settings.base) ?? entry.url) : undefined;
      // .gitmodules changed the URL since: fetches use the old one until it is synced.
      const stale = settingsUrl && url && comparable(settingsUrl) !== comparable(url);
      return {
        name: entry.name,
        path,
        url: url ? redactCredentials(url) : undefined,
        settingsUrl: stale ? redactCredentials(settingsUrl) : undefined,
        branch: entry.branch || undefined,
        // A staged change: HEAD's commit is the one status names (none for a new submodule).
        head: link.conflicted ? link.ours : change && change.index !== '.' ? change.headOid : link.oid,
        recorded: link.oid,
        checkedOut,
        state,
        modified: !!flags?.modified,
        untracked: !!flags?.untracked,
        nested: populated(repo, path) && existsSync(join(repo.root, path, '.gitmodules')),
      };
    }),
  );
  return list.filter((item): item is SubmoduleInfo => item !== undefined);
}

/**
 * Completes the submodules among uncommitted changes (`git diff` against the index): the commit
 * checked out in each (the diff leaves it out) and whether files inside are edited or new.
 * Submodules with only new files, which the diff does not list, are added.
 */
export async function completeSubmoduleChanges(
  repo: Repository,
  files: readonly ChangedFile[],
  status: StatusResult,
): Promise<ChangedFile[]> {
  // Conflicted ones are listed apart.
  const flagged = new Map(
    status.entries.flatMap((entry) =>
      entry.submodule && entry.kind !== 'unmerged' && entry.worktree !== '.'
        ? [[entry.path, entry] as const]
        : [],
    ),
  );
  if (flagged.size === 0 && !files.some((file) => file.submodule)) return [...files];
  const completed = await Promise.all(
    files.map(async (file): Promise<ChangedFile> => {
      if (!file.submodule) return file;
      const flags = flagged.get(file.path)?.submodule;
      // Its folder deleted: nothing is checked out.
      const to =
        file.status === 'D'
          ? undefined
          : flags?.commitChanged
            ? await submoduleHead(repo, file.path)
            : (file.submodule.to ?? file.submodule.from);
      return {
        ...file,
        submodule: { ...file.submodule, to, modified: !!flags?.modified, untracked: !!flags?.untracked },
      };
    }),
  );
  const listed = new Set(files.map((file) => file.path));
  for (const [path, entry] of flagged) {
    if (listed.has(path)) continue;
    completed.push({
      path,
      status: 'M',
      additions: 0,
      deletions: 0,
      binary: false,
      submodule: {
        from: entry.indexOid,
        to: entry.indexOid,
        modified: !!entry.submodule!.modified,
        untracked: !!entry.submodule!.untracked,
      },
    });
  }
  return completed;
}

/** Fills in the commit checked out in changed submodules (diffs against the files on disk leave it out). */
export async function withCheckedOutCommits(
  repo: Repository,
  files: readonly ChangedFile[],
): Promise<ChangedFile[]> {
  const unknown = (file: ChangedFile) => !!file.submodule && !file.submodule.to && file.status !== 'D';
  if (!files.some(unknown)) return [...files];
  return Promise.all(
    files.map(async (file) =>
      unknown(file)
        ? { ...file, submodule: { ...file.submodule, to: await submoduleHead(repo, file.path) } }
        : file,
    ),
  );
}

/** The conflicts over submodules among a stop's conflicts: each side's commit, and the one checked out. */
export async function readSubmoduleConflicts(
  repo: Repository,
  conflicts: readonly string[],
): Promise<SubmoduleConflict[]> {
  if (conflicts.length === 0) return [];
  const { stdout } = await repo.git(['ls-files', '--unmerged', '-z'], READ);
  const wanted = new Set(conflicts);
  return Promise.all(
    parseGitlinkConflicts(stdout)
      .filter((conflict) => wanted.has(conflict.path))
      .map(async (conflict) => ({ ...conflict, checkedOut: await submoduleHead(repo, conflict.path) })),
  );
}

/** An operation's state with its conflicts over submodules (a commit to choose for each). */
export async function withSubmoduleConflicts(repo: Repository, state: OpState): Promise<OpState> {
  const submodules = await readSubmoduleConflicts(repo, state.conflicts).catch(() => []);
  return submodules.length > 0 ? { ...state, submodules } : state;
}

/**
 * The folder of the repository linked to `repo` that `path` names: a checked-out submodule (by
 * its path) or another worktree (by its folder). Anything else is refused, with the reason.
 */
export async function linkedRepositoryFolder(repo: Repository, path: string): Promise<string> {
  if (typeof path !== 'string' || path === '') throw new Error('Name a submodule or a worktree.');
  const submodule = (await readGitmodules(repo)).find((entry) => entry.path === path);
  if (submodule) {
    const { stdout } = await repo.git(['ls-files', '--stage', '-z', ...filePaths(path)], READ);
    if (parseGitlinks(stdout).has(path)) {
      if (!populated(repo, path))
        throw new Error(`${path} is not checked out here: initialize or update it first.`);
      return join(repo.root, path);
    }
  }
  const worktrees = await readWorktrees(repo).catch(() => []);
  const tree = worktrees.find((candidate) => !candidate.bare && paths.same(candidate.path, path));
  if (tree && !tree.prunable) return tree.path;
  throw new Error(`${path} is not a submodule or worktree of ${repo.name}.`);
}
