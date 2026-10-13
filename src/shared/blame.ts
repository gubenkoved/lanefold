/**
 * Blame data as the editors show it, plus the line mapping behind "Annotate Previous Revision".
 * Pure: parsed and computed in the extension host, unit-tested without git.
 */

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
