import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isObjectId } from '../../shared/oid';
import type { SplitState } from '../../shared/operations';
import { filePaths, revisions } from '../git/args';
import { isAncestor, resolveCommit } from '../git/queries';
import type { Repository } from '../repo/repository';
import { readText } from '../util/files';

/*
 * Splitting a commit during a history edit. In git's todo a split is an `edit` line; the plan the
 * sequence editor leaves in rebase-merge/ lists which of those lines are splits. When git stops
 * at one, Lanefold takes the commit apart (`git reset HEAD~1`: its changes stay in the working
 * tree, uncommitted) and notes where its parts start. Continue commits whatever is left with the
 * original message, author and date, then lets the rebase go on. Everything lives in
 * rebase-merge/, so a split survives reloads and works the same when the rebase is continued from
 * a terminal (git's own documentation splits a commit this way).
 */

/** Written into `rebase-merge/` when a commit is taken apart: which one, and where its parts start. */
export const SPLIT_MARKER = 'lanefold-split.json';

/** Parts listed at most (a split can have any number). */
const MAX_PARTS = 100;
/** Longer path lists go to `git add` on stdin (Windows limits a command line to 32K characters). */
export const MAX_PATH_ARGS_LENGTH = 8000;

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(path);
  try {
    const value: unknown = text ? JSON.parse(text) : undefined;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The commit git stopped at to edit (HEAD at that moment); undefined when it stopped on a conflict. */
export async function editStopCommit(repo: Repository): Promise<string | undefined> {
  const amend = await readText(repo.gitPath('rebase-merge/amend'));
  return amend && isObjectId(amend) ? amend : undefined;
}

/**
 * The split the history edit in progress is stopped at, if any. `planFile` is the plan Lanefold's
 * sequence editor left in rebase-merge/ (it lists the commits to split).
 */
export async function readSplit(
  repo: Repository,
  options: { readonly planFile: string; readonly conflicts: readonly string[] },
): Promise<SplitState | undefined> {
  const plan = await readJson(options.planFile);
  const splits = Array.isArray(plan?.splits)
    ? plan.splits.filter((sha): sha is string => typeof sha === 'string' && isObjectId(sha))
    : [];
  if (splits.length === 0) return undefined;
  // The line git stopped at is the last one done (a todo edited by hand may abbreviate it).
  const done = await readText(repo.gitPath('rebase-merge/done'));
  const id = /^(?:e|edit)\s+([0-9a-f]{4,64})\b/.exec(done?.split('\n').at(-1)?.trim() ?? '')?.[1];
  const commit = id ? splits.find((sha) => sha.startsWith(id)) : undefined;
  if (!commit) return undefined;

  const [head, amend, marker, log] = await Promise.all([
    resolveCommit(repo, 'HEAD'),
    editStopCommit(repo),
    readJson(repo.gitPath(`rebase-merge/${SPLIT_MARKER}`)),
    repo.git(['log', '-1', '--format=%B', ...revisions(commit)], {
      readOnly: true,
      background: true,
      okExitCodes: [0, 128],
    }),
  ]);
  const message = log.exitCode === 0 ? log.stdout.replace(/\s+$/, '') : '';
  // Where its parts start: recorded when Lanefold took it apart, or (taken apart by hand, as git's
  // documentation shows) the parent of the commit git stopped at.
  let base: string | undefined;
  if (marker?.commit === commit && typeof marker.base === 'string' && isObjectId(marker.base))
    base = marker.base;
  else if (amend && head && head !== amend && options.conflicts.length === 0)
    base = await resolveCommit(repo, `${amend}~1`);
  const opened = !!base && !!head && (base === head || (await isAncestor(repo, base, head)));
  return {
    commit,
    subject: message.split('\n', 1)[0] ?? '',
    message,
    opened,
    parts: opened ? await partsSince(repo, base!) : [],
  };
}

/** The commits made on top of `base`, oldest first. */
async function partsSince(repo: Repository, base: string): Promise<SplitState['parts']> {
  const { stdout } = await repo.git(
    ['log', '--first-parent', `--max-count=${MAX_PARTS}`, '--format=%H %s', ...revisions('HEAD', `^${base}`)],
    { readOnly: true, background: true, label: 'Operation state' },
  );
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      return { sha: line.slice(0, space), subject: line.slice(space + 1) };
    })
    .reverse();
}

/** The files a commit changes (both sides of a rename), as git lists them. */
export async function changedPaths(repo: Repository, commit: string): Promise<string[]> {
  const { stdout } = await repo.git(
    [
      'diff-tree',
      '-r',
      '-z',
      '--root',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      ...revisions(commit),
    ],
    { readOnly: true, background: true, label: 'Files of the commit' },
  );
  return [...new Set(stdout.split('\0').filter(Boolean))];
}

/**
 * Of these paths, the files on disk that git ignores and does not track. A commit can hold such a
 * file (added with `git add -f`): taken apart, it is left untracked and ignored.
 */
export async function ignoredFiles(repo: Repository, paths: readonly string[]): Promise<string[]> {
  const present = paths.filter((path) => existsSync(join(repo.root, path)));
  if (present.length === 0) return [];
  const result = await repo.git(['check-ignore', '-z', '--stdin'], {
    readOnly: true,
    background: true,
    label: 'Ignored files',
    stdin: `${present.join('\0')}\0`,
    okExitCodes: [0, 1],
  });
  return result.stdout.split('\0').filter(Boolean);
}

/**
 * Pathspec arguments for exact paths: on the command line (`-- a b`), or read from stdin when the
 * list is long. Either way a name like `*.css` means that one file.
 */
export function literalPathArgs(
  paths: readonly string[],
  limit = MAX_PATH_ARGS_LENGTH,
): { readonly args: readonly string[]; readonly stdin?: string } {
  const args = filePaths(...paths);
  if (args.reduce((length, arg) => length + arg.length + 1, 0) <= limit) return { args };
  return {
    args: ['--pathspec-from-file=-', '--pathspec-file-nul'],
    stdin: `${args.slice(1).join('\0')}\0`,
  };
}

/** One step of a split, as planned (see {@link runSplitStep}). */
export type SplitStep =
  | {
      readonly step: 'open';
      readonly commit: string;
      /**
       * `commit`: git stopped after committing it (an edit stop), so HEAD goes back to its parent.
       * `resolution`: git stopped on a conflict, since resolved and staged on the parent: unstage it.
       */
      readonly from: 'commit' | 'resolution';
    }
  | {
      readonly step: 'finish';
      readonly commit: string;
      /** Stage what is left of its files (`git add -A`); absent when nothing is. */
      readonly add?: {
        readonly args: readonly string[];
        readonly stdin?: string;
        /** Some of them are ignored files the commit holds (`-f`). */
        readonly force?: boolean;
      };
      /** Commit what is staged with the original message, author and date. */
      readonly commitRest: boolean;
    }
  | {
      readonly step: 'abort';
      /**
       * Its new files, untracked since it was taken apart, are tracked again first: git would
       * not overwrite them to put the history back.
       */
      readonly add: { readonly args: readonly string[]; readonly stdin?: string };
    };

/** The commands of a split step, as the plan shows them and {@link runSplitStep} runs them. */
export function splitStepArgs(step: SplitStep): string[][] {
  if (step.step === 'open')
    return [step.from === 'commit' ? ['reset', '--mixed', 'HEAD~1'] : ['reset', '--mixed']];
  if (step.step === 'abort')
    return [
      ['add', '-A', ...step.add.args],
      ['rebase', '--abort'],
    ];
  return [
    ...(step.add ? [['add', '-A', ...(step.add.force ? ['-f'] : []), ...step.add.args]] : []),
    ...(step.commitRest ? [['commit', '-C', step.commit]] : []),
    ['rebase', '--continue'],
  ];
}

/**
 * Runs a split step. Opening takes the commit apart and records where its parts start; finishing
 * stages what is left of the commit's files, commits it as the original (when anything is
 * staged), and lets the rebase go on; aborting tracks its new files again, then aborts.
 */
export async function runSplitStep(
  repo: Repository,
  step: SplitStep,
  options: { readonly env: Record<string, string>; readonly label: string },
): Promise<void> {
  const run = (args: readonly string[], stdin?: string) =>
    repo.git(args, { env: options.env, label: options.label, stdin });
  if (step.step === 'open') {
    await run(splitStepArgs(step)[0]!);
    const base = await resolveCommit(repo, 'HEAD');
    await writeFile(
      repo.gitPath(`rebase-merge/${SPLIT_MARKER}`),
      JSON.stringify({ commit: step.commit, base }),
    );
    return;
  }
  for (const args of splitStepArgs(step)) {
    if (args[0] === 'commit') {
      // Nothing staged after all (the files changed since this was planned): nothing to commit.
      const staged = await repo.git(['diff', '--cached', '--quiet'], { okExitCodes: [0, 1] });
      if (staged.exitCode === 0) continue;
    }
    await run(args, args[0] === 'add' ? step.add?.stdin : undefined);
  }
}
