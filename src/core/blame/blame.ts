import {
  mapLineToOld,
  parseBlamePorcelain,
  parseHunks,
  type BlameCommit,
  type BlameResult,
} from '../../shared/blame';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRevision, revisions } from '../git/args';
import type { Repository } from '../repo/repository';

export interface BlameOptions {
  /** Revision to blame; without it, the file in the working tree (or `contents`) is blamed. */
  readonly rev?: string;
  /** Unsaved editor contents to blame instead of the file on disk (on top of `rev` or HEAD). */
  readonly contents?: string;
  /** Ignore whitespace-only changes (`-w`). */
  readonly ignoreWhitespace?: boolean;
  /** Follow lines moved or copied within the file (`-M`). */
  readonly detectMoves?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * `git blame --porcelain` for one file. The repository's `blame.ignoreRevsFile` and mailmap
 * apply as usual. Paths are relative to the repository root.
 */
export async function blameFile(
  repo: Repository,
  path: string,
  options: BlameOptions = {},
): Promise<BlameResult> {
  const args = ['blame', '--porcelain'];
  if (options.ignoreWhitespace) args.push('-w');
  if (options.detectMoves) args.push('-M');
  if (options.contents !== undefined) args.push('--contents', '-');
  // blame parses its own arguments and has no --end-of-options; the revision is checked instead.
  if (options.rev) args.push(assertRevision(options.rev));
  args.push('--', path);
  const { stdout } = await repo.git(args, {
    readOnly: true,
    background: true,
    label: 'Blame',
    stdin: options.contents,
    signal: options.signal,
  });
  return parseBlamePorcelain(stdout);
}

export interface PreviousLine {
  /** The commit the file is shown at (the blamed commit's parent). */
  readonly sha: string;
  readonly path: string;
  /** 1-based line in that version. */
  readonly line: number;
}

/**
 * For "Annotate Previous Revision": the version of the file before `commit` changed the line,
 * and where the line (`origLine`, 1-based in `commit`'s version) was in it. Lines the commit
 * changed map to the matching line of what they replaced; lines it added map to the line
 * before them. Uncommitted lines (working tree) map against HEAD's version.
 */
export async function previousLine(
  repo: Repository,
  commit: BlameCommit,
  origLine: number,
  worktreePath?: string,
  /** Unsaved editor contents the blame was computed on (instead of the file on disk). */
  contents?: string,
): Promise<PreviousLine | undefined> {
  const previous = commit.previous;
  if (!previous) return undefined;
  const newSide = commit.uncommitted ? undefined : `${commit.sha}:${commit.filename}`;
  const args = ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv'];
  const options = { readOnly: true, background: true, label: 'Map line to the previous revision' };
  const { stdout } = newSide
    ? await repo.git([...args, ...revisions(`${previous.sha}:${previous.path}`, newSide)], options)
    : contents !== undefined
      ? { stdout: await diffWithContents(repo, `${previous.sha}:${previous.path}`, contents) }
      : await repo.git([...args, ...revisions(previous.sha), '--', worktreePath ?? previous.path], options);
  return { sha: previous.sha, path: previous.path, line: mapLineToOld(parseHunks(stdout), origLine) };
}

/**
 * `git diff -U0` from a file at a revision (`<rev>:<path>`) to some text, such as an editor's
 * unsaved contents: both sides go through temporary files.
 */
export async function diffWithContents(repo: Repository, blob: string, contents: string): Promise<string> {
  const dir = join(tmpdir(), `lanefold-diff-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    const before = join(dir, 'before');
    const after = join(dir, 'after');
    const old = await repo.gitBuffer(['cat-file', 'blob', ...revisions(blob)], {
      readOnly: true,
      background: true,
      label: 'Read file at revision',
    });
    await writeFile(before, old.stdout);
    await writeFile(after, contents);
    const { stdout } = await repo.git(
      ['diff', '--no-index', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--', before, after],
      { readOnly: true, background: true, label: 'Map lines', okExitCodes: [0, 1] },
    );
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The full message of a commit (for hovers). */
export async function commitMessage(repo: Repository, sha: string): Promise<string> {
  const { stdout } = await repo.git(['log', '-1', '--format=%B', ...revisions(sha)], {
    readOnly: true,
    background: true,
    label: 'Commit message',
  });
  return stdout.replace(/\s+$/, '');
}
