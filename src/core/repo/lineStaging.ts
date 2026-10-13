import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isLineSelection,
  type DiffArea,
  type DiffLineKind,
  type FileHunks,
  type LineSelection,
  type WholeFileReason,
} from '../../shared/hunks';
import { filePaths } from '../git/args';
import { parseFilePatch, type FilePatch, type PatchLine } from '../parsers/unifiedDiff';
import { fileName } from '../util/wording';
import { buildLinePatch, wholeFileMessage, wholeFileReason, type LinePatch } from './linePatch';
import type { Repository } from './repository';

/** Diffs with more changed lines than this are not shown inline (the diff editor copes better). */
export const MAX_INLINE_LINES = 3000;
/** Nor diffs, or new files, larger than this. */
export const MAX_INLINE_BYTES = 1024 * 1024;

/** The diffs patches are built from: git's plain unified format, three lines of context. */
const DIFF_ARGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--unified=3'];
const NUMSTAT_ARGS = ['--numstat', '-z', '--no-ext-diff', '--no-textconv'];

/** One file's diff as the backend read it. */
export interface FileDiff {
  readonly path: string;
  readonly area: DiffArea;
  /** Hash of git's output: line actions name it, and are refused when the diff is no longer this one. */
  readonly fingerprint: string;
  /** The parsed diff (git's bytes as 'latin1' text); absent when it was not read (too large, a link). */
  readonly patch?: FilePatch;
  readonly wholeFile?: WholeFileReason;
  readonly renamedFrom?: string;
  readonly additions: number;
  readonly deletions: number;
}

interface ReadOptions {
  readonly signal?: AbortSignal;
}

/** Whether a path from the webview looks like one git lists: relative to the repository, no NUL. */
export function isFilePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 4096 &&
    !path.includes('\0') &&
    !path.startsWith('/')
  );
}

/** A file path from the webview (see {@link isFilePath}). */
export function checkFilePath(path: unknown): string {
  if (!isFilePath(path)) throw new Error('Not a file path.');
  return path;
}

/** An area from the webview, one of those the action allows. */
export function checkArea<T extends DiffArea>(area: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(area as T)) throw new Error(`Not a diff area here: ${String(area)}.`);
  return area as T;
}

/** A line action as the backend runs it. */
export interface LineRequest {
  readonly path: string;
  readonly area: DiffArea;
  readonly fingerprint: string;
  readonly selection: LineSelection;
}

/** Checks a line action's parameters from the webview. */
export function lineRequest(
  path: unknown,
  area: DiffArea,
  fingerprint: unknown,
  selection: unknown,
): LineRequest {
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{0,64}$/.test(fingerprint))
    throw new Error('The diff shown is unknown: review it again.');
  if (!isLineSelection(selection)) throw new Error('Choose the lines first.');
  return { path: checkFilePath(path), area, fingerprint, selection };
}

/** The line action was refused: the file's diff is not the one shown any more. */
export function staleDiff(path: string): Error {
  return Object.assign(new Error(`${fileName(path)} changed since it was shown: review it again.`), {
    code: 'stale',
  });
}

/** Reads one file's unstaged, staged or untracked changes the way line actions see them. */
export function readFileDiff(
  repo: Repository,
  path: string,
  area: DiffArea,
  options: ReadOptions = {},
): Promise<FileDiff> {
  switch (area) {
    case 'unstaged':
      return readUnstaged(repo, path, options);
    case 'staged':
      return readStaged(repo, path, options);
    case 'untracked':
      return readUntracked(repo, path, options);
    default:
      throw new Error(`Not a diff area: ${String(area)}.`);
  }
}

interface Stat {
  readonly path: string;
  /** Renames: the path before. */
  readonly from?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

/** Parses `--numstat -z` ("added\tdeleted\tpath\0", or "added\tdeleted\t\0from\0to\0" for renames). */
function parseNumstat(output: string): Stat[] {
  const tokens = output.split('\0');
  const stats: Stat[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]!);
    if (!match) continue;
    const binary = match[1] === '-';
    const counts = {
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      binary,
    };
    if (match[3] === '') {
      stats.push({ ...counts, from: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '' });
      i += 2;
    } else stats.push({ ...counts, path: match[3]! });
  }
  return stats;
}

const READ = { readOnly: true, background: true } as const;

async function readUnstaged(repo: Repository, path: string, { signal }: ReadOptions): Promise<FileDiff> {
  const { stdout } = await repo.git(['diff', ...NUMSTAT_ARGS, '--no-renames', ...filePaths(path)], {
    ...READ,
    signal,
    label: 'Unstaged changes',
  });
  const stats = parseNumstat(stdout);
  if (stats.some((stat) => stat.path !== path)) throw new Error(`${path} is not a file.`);
  return readDiff(repo, path, 'unstaged', ['diff', ...DIFF_ARGS, '--no-renames', ...filePaths(path)], {
    stat: stats[0],
    signal,
  });
}

async function readStaged(repo: Repository, path: string, { signal }: ReadOptions): Promise<FileDiff> {
  // Renames are found among all staged changes (git pairs the paths), as the file list shows them.
  const { stdout } = await repo.git(['diff', '--cached', ...NUMSTAT_ARGS, '-M'], {
    ...READ,
    signal,
    label: 'Staged changes',
  });
  const stat = parseNumstat(stdout).find((entry) => entry.path === path || entry.from === path);
  const from = stat?.from;
  const args = from
    ? ['diff', '--cached', ...DIFF_ARGS, '-M', ...filePaths(from, stat.path)]
    : ['diff', '--cached', ...DIFF_ARGS, '--no-renames', ...filePaths(path)];
  return readDiff(repo, path, 'staged', args, { stat, signal, renamedFrom: from });
}

async function readUntracked(repo: Repository, path: string, { signal }: ReadOptions): Promise<FileDiff> {
  // `--no-index` reads any path: only a file git itself lists as new (inside, not ignored) will do.
  const { stdout } = await repo.git(
    ['ls-files', '--others', '--exclude-standard', '-z', ...filePaths(path)],
    {
      ...READ,
      signal,
      label: 'Untracked file',
    },
  );
  if (stdout !== `${path}\0`) throw new Error(`${path} is not a new file in this repository.`);
  const file = await lstat(join(repo.root, path));
  const unread = { path, area: 'untracked', fingerprint: '', additions: 0, deletions: 0 } as const;
  if (file.isSymbolicLink()) return { ...unread, wholeFile: 'symlink' };
  // A folder git lists as one entry is a repository of its own: it is added as a submodule.
  if (file.isDirectory()) return { ...unread, wholeFile: 'submodule' };
  if (!file.isFile()) throw new Error(`${path} is not a file.`);
  if (file.size > MAX_INLINE_BYTES) return { ...unread, wholeFile: 'tooLarge' };
  return readDiff(repo, path, 'untracked', ['diff', '--no-index', ...DIFF_ARGS, '--', '/dev/null', path], {
    signal,
  });
}

/** Runs the diff and parses it, unless its counts say it is too large to show. */
async function readDiff(
  repo: Repository,
  path: string,
  area: DiffArea,
  args: string[],
  options: { stat?: Stat; renamedFrom?: string; signal?: AbortSignal },
): Promise<FileDiff> {
  const { stat, renamedFrom } = options;
  const base = { path, area, renamedFrom, additions: stat?.additions ?? 0, deletions: stat?.deletions ?? 0 };
  if (stat && !stat.binary && stat.additions + stat.deletions > MAX_INLINE_LINES)
    return { ...base, fingerprint: '', wholeFile: 'tooLarge' };
  // `--no-index` exits with 1 when the files differ.
  const { stdout: raw } = await repo.gitBuffer(args, {
    ...READ,
    signal: options.signal,
    okExitCodes: area === 'untracked' ? [0, 1] : [0],
    label:
      area === 'staged' ? 'Staged changes' : area === 'untracked' ? 'Untracked file' : 'Unstaged changes',
  });
  const fingerprint = createHash('sha256').update(raw).digest('hex');
  if (raw.length > MAX_INLINE_BYTES) return { ...base, fingerprint, wholeFile: 'tooLarge' };
  const patch = parseFilePatch(raw.toString('latin1'));
  if (patch.files > 1) throw new Error(`${path} is not a file.`);
  if (patch.combined) throw new Error(`${path} is conflicted: resolve it first.`);
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch.hunks)
    for (const line of hunk.lines) {
      if (line.kind === '+') additions++;
      else if (line.kind === '-') deletions++;
    }
  if (additions + deletions > MAX_INLINE_LINES)
    return { ...base, fingerprint, additions, deletions, wholeFile: 'tooLarge' };
  return { ...base, fingerprint, patch, wholeFile: wholeFileReason(patch), additions, deletions };
}

const KINDS: Record<PatchLine['kind'], DiffLineKind> = { ' ': 'context', '+': 'added', '-': 'removed' };

/** Git's bytes as text for the webview (UTF-8; a CRLF line's carriage return is not shown). */
function display(text: string): string {
  return Buffer.from(text, 'latin1').toString('utf8').replace(/\r$/, '');
}

/** What the webview shows of a file's diff. */
export function toFileHunks(diff: FileDiff): FileHunks {
  const { patch } = diff;
  return {
    path: diff.path,
    area: diff.area,
    fingerprint: diff.fingerprint,
    hunks: (patch?.hunks ?? []).map((hunk) => ({
      oldStart: hunk.oldStart,
      oldCount: hunk.oldCount,
      newStart: hunk.newStart,
      newCount: hunk.newCount,
      section: hunk.section ? display(hunk.section) : undefined,
      lines: hunk.lines.map((line) => ({
        kind: KINDS[line.kind],
        text: display(line.text),
        oldLine: line.oldLine,
        newLine: line.newLine,
        noEol: line.noEol || undefined,
        cr: line.text.endsWith('\r') || undefined,
      })),
    })),
    wholeFile: diff.wholeFile,
    renamedFrom: diff.renamedFrom,
    modes: patch?.oldMode && patch.newMode ? { from: patch.oldMode, to: patch.newMode } : undefined,
    created: patch?.created || undefined,
    deleted: patch?.deleted || undefined,
    additions: diff.additions,
    deletions: diff.deletions,
  };
}

/**
 * Builds the patch of some lines of a file's diff (forward to stage, `reverse` to unstage or
 * discard), from the diff as it is now: refused when that is no longer the diff shown.
 */
export async function linePatchFor(
  repo: Repository,
  request: LineRequest,
  reverse: boolean,
): Promise<LinePatch> {
  const diff = await readFileDiff(repo, request.path, request.area);
  if (diff.fingerprint !== request.fingerprint) throw staleDiff(request.path);
  if (diff.wholeFile || !diff.patch)
    throw new Error(wholeFileMessage(fileName(request.path), diff.wholeFile ?? 'tooLarge'));
  const patch = buildLinePatch(diff.patch, request.selection, reverse);
  if (!patch) throw new Error('Choose the lines first.');
  return patch;
}

/** The patch as git's bytes. */
export function patchBytes(patch: LinePatch): Buffer {
  return Buffer.from(patch.text, 'latin1');
}

/** Applies a line patch to the index only (`git apply --cached`), forward or in reverse. */
export async function applyToIndex(
  repo: Repository,
  patch: LinePatch,
  reverse: boolean,
  label: string,
): Promise<void> {
  await repo.git(['apply', '--cached', ...(reverse ? ['--reverse'] : []), '--whitespace=nowarn'], {
    stdin: patchBytes(patch),
    label,
  });
}

/** Whether the file on disk differs from its staged version (unstaging would lose that version). */
export async function differsOnDisk(repo: Repository, path: string): Promise<boolean> {
  const result = await repo.git(['diff', '--quiet', '--no-ext-diff', ...filePaths(path)], {
    ...READ,
    label: 'Unstaged edits',
    okExitCodes: [0, 1],
  });
  return result.exitCode === 1;
}
