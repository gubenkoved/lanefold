/**
 * One file's changes as hunks and lines, for staging, unstaging or discarding parts of them.
 * The backend parses git's own diff and builds every patch from it: the webview names lines
 * only by their position in that diff, with the fingerprint of the diff it showed.
 */

/** Which changes of a file: unstaged (index → disk), staged (HEAD → index), or a new file git does not track yet. */
export type DiffArea = 'unstaged' | 'staged' | 'untracked';

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** The text, without its line break. */
  readonly text: string;
  /** Line number before the change (context and removed lines). */
  readonly oldLine?: number;
  /** Line number after the change (context and added lines). */
  readonly newLine?: number;
  /** The file ends with this line, without a line break (git's "\ No newline at end of file"). */
  readonly noEol?: boolean;
  /** The line ends with a carriage return (a CRLF line break), which `text` leaves out. */
  readonly cr?: boolean;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** What git shows after the line range: the function or section the hunk is in. */
  readonly section?: string;
  readonly lines: readonly DiffLine[];
}

/** Why a file's changes can only be staged, unstaged or discarded as a whole. */
export type WholeFileReason = 'binary' | 'tooLarge' | 'renamed' | 'modeChange' | 'submodule' | 'symlink';

/** What `diff.hunks` returns. */
export interface FileHunks {
  readonly path: string;
  readonly area: DiffArea;
  /** Identifies the diff shown: line actions name it, and are refused once the file changed. */
  readonly fingerprint: string;
  /** Empty for binary files and diffs too large to show; read-only when `wholeFile` is set. */
  readonly hunks: readonly DiffHunk[];
  readonly wholeFile?: WholeFileReason;
  /** A staged rename: where the file was before. */
  readonly renamedFrom?: string;
  /** A mode change (e.g. 100644 → 100755). */
  readonly modes?: { readonly from: string; readonly to: string };
  /** The file is new, or deleted (an empty one has no hunks to show). */
  readonly created?: boolean;
  readonly deleted?: boolean;
  /** Changed lines in all (known for diffs too large to show too). */
  readonly additions: number;
  readonly deletions: number;
}

/** An added or removed line: the index of its hunk, and its index within the hunk's lines. */
export interface LineRef {
  readonly hunk: number;
  readonly line: number;
}

/** Parts of a file's diff, by position in the diff `diff.hunks` returned. */
export interface LineSelection {
  /** Whole hunks. */
  readonly hunks?: readonly number[];
  /** Single added or removed lines. */
  readonly lines?: readonly LineRef[];
}

/** More positions than any diff that can be shown inline has. */
const MAX_POSITIONS = 100_000;

const isIndex = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_POSITIONS;

/** Checks the shape of a selection from the webview (the backend checks positions against its own diff). */
export function isLineSelection(value: unknown): value is LineSelection {
  if (!value || typeof value !== 'object') return false;
  const { hunks, lines } = value as Record<string, unknown>;
  const validHunks =
    hunks === undefined || (Array.isArray(hunks) && hunks.length <= MAX_POSITIONS && hunks.every(isIndex));
  const validLines =
    lines === undefined ||
    (Array.isArray(lines) &&
      lines.length <= MAX_POSITIONS &&
      lines.every(
        (ref: unknown) =>
          !!ref &&
          typeof ref === 'object' &&
          isIndex((ref as LineRef).hunk) &&
          isIndex((ref as LineRef).line),
      ));
  return validHunks && validLines;
}

/** "1 line", "3 lines". */
export function linesLabel(count: number): string {
  return `${count} line${count === 1 ? '' : 's'}`;
}
