/**
 * Blame data as the editors show it, plus the line mapping behind "Annotate Previous Revision".
 * Pure: parsed and computed in the extension host, unit-tested without git.
 */
import { calendarDate, isoDate, relativeLong, relativeTime } from './time';

export interface BlameCommit {
  readonly sha: string;
  readonly author: string;
  /** Without the angle brackets. */
  readonly authorMail: string;
  /** Seconds since the epoch. */
  readonly authorTime: number;
  readonly authorTz: string;
  readonly committer: string;
  readonly committerMail: string;
  readonly committerTime: number;
  readonly summary: string;
  /** The file as it was before this commit changed the line (absent where the line was born). */
  readonly previous?: { readonly sha: string; readonly path: string };
  /** The file's path in this commit (it may have been renamed since). */
  readonly filename: string;
  /** The commit is a boundary (`--root`-less blame stopped there, or a shallow clone's edge). */
  readonly boundary: boolean;
  /** Lines changed in the working tree or editor but not committed yet. */
  readonly uncommitted: boolean;
}

export interface BlameLine {
  readonly sha: string;
  /** 1-based line number in the commit's version of the file. */
  readonly origLine: number;
}

export interface BlameResult {
  /** Per line of the blamed content (index = line number − 1). */
  readonly lines: readonly BlameLine[];
  readonly commits: ReadonlyMap<string, BlameCommit>;
}

/** Undoes git's C-style quoting of unusual paths ("a\tb" → a<TAB>b, octal escapes as UTF-8). */
export function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const encoder = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i, i + 3);
      bytes.push(parseInt(octal, 8));
      i += 2;
      continue;
    }
    const escapes: Record<string, string> = {
      n: '\n',
      t: '\t',
      r: '\r',
      a: '\x07',
      b: '\b',
      f: '\f',
      v: '\v',
    };
    bytes.push(...encoder.encode(escapes[next] ?? next));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const ZERO = /^0+$/;

/** Parses `git blame --porcelain` output. */
export function parseBlamePorcelain(output: string): BlameResult {
  const lines: BlameLine[] = [];
  const commits = new Map<string, BlameCommit>();
  type Draft = { -readonly [K in keyof BlameCommit]: BlameCommit[K] };
  const drafts = new Map<string, Draft>();
  let current: Draft | undefined;
  const rows = output.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.startsWith('\t')) continue; // the line's content
    const header = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(row);
    if (header) {
      const sha = header[1]!;
      current = drafts.get(sha);
      if (!current) {
        current = {
          sha,
          author: '',
          authorMail: '',
          authorTime: 0,
          authorTz: '+0000',
          committer: '',
          committerMail: '',
          committerTime: 0,
          summary: '',
          filename: '',
          boundary: false,
          uncommitted: ZERO.test(sha),
        };
        drafts.set(sha, current);
      }
      lines[Number(header[3]) - 1] = { sha, origLine: Number(header[2]) };
      continue;
    }
    if (!current) continue;
    const space = row.indexOf(' ');
    const key = space < 0 ? row : row.slice(0, space);
    const value = space < 0 ? '' : row.slice(space + 1);
    switch (key) {
      case 'author':
        current.author = value;
        break;
      case 'author-mail':
        current.authorMail = value.replace(/^<|>$/g, '');
        break;
      case 'author-time':
        current.authorTime = Number(value) || 0;
        break;
      case 'author-tz':
        current.authorTz = value;
        break;
      case 'committer':
        current.committer = value;
        break;
      case 'committer-mail':
        current.committerMail = value.replace(/^<|>$/g, '');
        break;
      case 'committer-time':
        current.committerTime = Number(value) || 0;
        break;
      case 'summary':
        current.summary = value;
        break;
      case 'boundary':
        current.boundary = true;
        break;
      case 'filename':
        current.filename = unquotePath(value);
        break;
      case 'previous': {
        const split = value.indexOf(' ');
        if (split > 0)
          current.previous = { sha: value.slice(0, split), path: unquotePath(value.slice(split + 1)) };
        break;
      }
    }
  }
  for (const [sha, draft] of drafts) commits.set(sha, draft);
  // Lines git did not report (should not happen) get no commit rather than a hole.
  for (let i = 0; i < lines.length; i++) lines[i] ??= { sha: '', origLine: i + 1 };
  return { lines, commits };
}

/** A hunk of `git diff -U0`: old lines a..a+b-1 became new lines c..c+d-1. */
export interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

/** Hunk headers of a unified diff (`@@ -a,b +c,d @@`). */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newCount: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return hunks;
}

/**
 * Where line `line` (1-based) of the new version was in the old version, given the hunks of
 * `git diff -U0 old new`. Unchanged lines map exactly; a changed line maps to the matching
 * position inside the lines it replaced; an inserted line maps to the line before the insertion.
 */
export function mapLineToOld(hunks: readonly Hunk[], line: number, oldLineCount?: number): number {
  let delta = 0;
  let mapped: number | undefined;
  for (const hunk of hunks) {
    const before = hunk.newCount > 0 ? line < hunk.newStart : line <= hunk.newStart;
    if (before) {
      mapped = line - delta;
      break;
    }
    if (hunk.newCount > 0 && line < hunk.newStart + hunk.newCount) {
      mapped =
        hunk.oldCount > 0
          ? hunk.oldStart + Math.min(line - hunk.newStart, hunk.oldCount - 1)
          : Math.max(1, hunk.oldStart);
      break;
    }
    delta += hunk.newCount - hunk.oldCount;
  }
  mapped ??= line - delta;
  const max = oldLineCount === undefined ? Infinity : Math.max(1, oldLineCount);
  return Math.min(max, Math.max(1, mapped));
}

/**
 * How annotations name a commit's author: "Maneeshi Sharma" (full), "Maneeshi" (first),
 * "Maneeshi S." (firstInitial), "M. Sharma" (initialLast), "MS" (initials), the name of their
 * email address (email), or not at all (none).
 */
export type BlameAuthorStyle =
  'full' | 'first' | 'firstInitial' | 'initialLast' | 'initials' | 'email' | 'none';
/**
 * How annotations date a commit: "3d ago" for the last week and the day before that (auto),
 * "9 years ago" (relative), "Mar 16, 2017" (date), "2017-03-16" (iso), or not at all (none).
 */
export type BlameDateStyle = 'auto' | 'relative' | 'date' | 'iso' | 'none';

export const BLAME_AUTHOR_STYLES: readonly BlameAuthorStyle[] = [
  'full',
  'first',
  'firstInitial',
  'initialLast',
  'initials',
  'email',
  'none',
];
export const BLAME_DATE_STYLES: readonly BlameDateStyle[] = ['auto', 'relative', 'date', 'iso', 'none'];

/** An author as annotations name them (see {@link BlameAuthorStyle}). */
export function authorLabel(name: string, email: string, style: BlameAuthorStyle): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  // The first character, whatever its script (a surrogate pair stays whole).
  const initial = (word: string) => Array.from(word)[0] ?? '';
  const mailbox = email.slice(0, Math.max(0, email.indexOf('@'))) || email;
  if (style === 'none') return '';
  if (style === 'email') return mailbox || name.trim();
  if (!first) return mailbox;
  switch (style) {
    case 'first':
      return first;
    case 'firstInitial':
      return last ? `${first} ${initial(last)}.` : first;
    case 'initialLast':
      return last ? `${initial(first)}. ${last}` : first;
    case 'initials':
      return `${initial(first)}${last ? initial(last) : ''}`.toUpperCase();
    default:
      return words.join(' ');
  }
}

/** When a commit was made, as annotations say it (see {@link BlameDateStyle}). */
export function dateLabel(seconds: number, style: BlameDateStyle, nowMs = Date.now()): string {
  switch (style) {
    case 'none':
      return '';
    case 'relative':
      return relativeLong(seconds, nowMs);
    case 'date':
      return calendarDate(seconds);
    case 'iso':
      return isoDate(seconds);
    default:
      return relativeTime(seconds, nowMs);
  }
}

const NBSP = '\u00a0';

/**
 * Each commit's annotation, "Mar 4, 2024  Alice Archer": the date first, then the author, the
 * authors lined up after the file's longest date so the column reads like a timeline. Lines
 * not committed yet say so.
 */
export function annotationTexts(
  commits: ReadonlyMap<string, BlameCommit>,
  style: { readonly author: BlameAuthorStyle; readonly date: BlameDateStyle },
  nowMs = Date.now(),
): Map<string, string> {
  const parts = new Map<string, readonly [date: string, author: string]>();
  for (const commit of commits.values()) {
    const date =
      style.date === 'none'
        ? ''
        : commit.uncommitted
          ? 'uncommitted'
          : dateLabel(commit.authorTime, style.date, nowMs);
    const author =
      style.author === 'none'
        ? ''
        : commit.uncommitted
          ? 'you'
          : authorLabel(commit.author, commit.authorMail, style.author);
    parts.set(commit.sha, [date, author]);
  }
  const column = Math.max(0, ...[...parts.values()].map(([date]) => date.length)) + 1;
  const texts = new Map<string, string>();
  for (const [sha, [date, author]] of parts) {
    texts.set(sha, date && author ? `${date}${NBSP.repeat(column - date.length)}${author}` : date || author);
  }
  return texts;
}

/** Blocks of consecutive lines from the same commit (0-based start, length). */
export function blameBlocks(result: BlameResult): { start: number; length: number; sha: string }[] {
  const blocks: { start: number; length: number; sha: string }[] = [];
  result.lines.forEach((line, index) => {
    const last = blocks[blocks.length - 1];
    if (last && last.sha === line.sha && last.start + last.length === index) last.length++;
    else blocks.push({ start: index, length: 1, sha: line.sha });
  });
  return blocks;
}
