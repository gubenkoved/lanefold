/**
 * Parses git's unified diff of one file into hunks and lines. The text is git's output decoded
 * one character per byte ('latin1'), so patches built from it give git back its exact bytes.
 */

/** A line of a hunk as git printed it: marker, text (without the line break). */
export interface PatchLine {
  readonly kind: ' ' | '+' | '-';
  readonly text: string;
  /** Followed by "\ No newline at end of file": its side of the file ends without a line break. */
  readonly noEol: boolean;
  /** Line number before (context and removed lines). */
  readonly oldLine?: number;
  /** Line number after (context and added lines). */
  readonly newLine?: number;
}

export interface PatchHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** The function context git prints after the range ('' when none). */
  readonly section: string;
  readonly lines: readonly PatchLine[];
}

export interface FilePatch {
  /** The lines before the first hunk: "diff --git", mode and index lines, "---" and "+++". */
  readonly header: readonly string[];
  readonly hunks: readonly PatchHunk[];
  /** How many files the text describes ("diff " lines); a single-file diff has one, or none when empty. */
  readonly files: number;
  readonly binary: boolean;
  /** A combined diff (`diff --cc`): the file is conflicted. */
  readonly combined: boolean;
  /** The file is new (`--- /dev/null`) or deleted (`+++ /dev/null`). */
  readonly created: boolean;
  readonly deleted: boolean;
  /** A rename or copy. */
  readonly renamed: boolean;
  /** A mode change ("old mode" / "new mode"). */
  readonly oldMode?: string;
  readonly newMode?: string;
  /** Every file mode the header names: 120000 is a symbolic link, 160000 a submodule. */
  readonly modes: readonly string[];
}

/** The marker git prints after a line that ends its file without a line break. */
export const NO_EOL_MARKER = '\\ No newline at end of file';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

class DiffSyntaxError extends Error {
  constructor(message: string) {
    super(`Lanefold could not read git's diff: ${message}`);
  }
}

/** Parses `git diff` output for one file (several files are counted in `files`, for the caller to refuse). */
export function parseFilePatch(text: string): FilePatch {
  const lines = text.split('\n');
  // Every line git prints ends with a line break: the last element is what follows the last one.
  if (lines.at(-1) === '') lines.pop();
  const header: string[] = [];
  const hunks: PatchHunk[] = [];
  const modes: string[] = [];
  let files = 0;
  let binary = false;
  let combined = false;
  let created = false;
  let deleted = false;
  let renamed = false;
  let oldMode: string | undefined;
  let newMode: string | undefined;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff ')) {
      files++;
      if (/^diff --(?:cc|combined) /.test(line)) combined = true;
      if (files === 1) header.push(line);
      i++;
      continue;
    }
    // A combined diff's hunks (@@@ …) are not parsed: only whole-file actions apply to conflicts.
    if (combined || files > 1) {
      i++;
      continue;
    }
    const range = HUNK_HEADER.exec(line);
    if (range) {
      const [hunk, next] = parseHunk(lines, i, range);
      hunks.push(hunk);
      i = next;
      continue;
    }
    if (hunks.length > 0)
      throw new DiffSyntaxError(`unexpected line after the hunks (“${line.slice(0, 60)}”).`);
    header.push(line);
    i++;
    let match: RegExpExecArray | null;
    if ((match = /^new file mode (\d+)$/.exec(line))) {
      created = true;
      modes.push(match[1]!);
    } else if ((match = /^deleted file mode (\d+)$/.exec(line))) {
      deleted = true;
      modes.push(match[1]!);
    } else if ((match = /^old mode (\d+)$/.exec(line))) {
      oldMode = match[1]!;
      modes.push(oldMode);
    } else if ((match = /^new mode (\d+)$/.exec(line))) {
      newMode = match[1]!;
      modes.push(newMode);
    } else if ((match = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d+)$/.exec(line))) {
      modes.push(match[1]!);
    } else if (/^(?:rename|copy) (?:from|to) |^similarity index /.test(line)) {
      renamed = true;
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      binary = true;
    } else if (line === '--- /dev/null') {
      created = true;
    } else if (line === '+++ /dev/null') {
      deleted = true;
    }
  }
  return { header, hunks, files, binary, combined, created, deleted, renamed, oldMode, newMode, modes };
}

/** Reads the hunk whose header is `lines[start]`; returns it and the index of the line after it. */
function parseHunk(lines: readonly string[], start: number, range: RegExpExecArray): [PatchHunk, number] {
  const oldStart = Number(range[1]);
  const oldCount = range[2] === undefined ? 1 : Number(range[2]);
  const newStart = Number(range[3]);
  const newCount = range[4] === undefined ? 1 : Number(range[4]);
  const parsed: {
    kind: PatchLine['kind'];
    text: string;
    noEol: boolean;
    oldLine?: number;
    newLine?: number;
  }[] = [];
  let oldLeft = oldCount;
  let newLeft = newCount;
  let oldLine = oldStart;
  let newLine = newStart;
  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" (worded in git's language): about the line before.
      const last = parsed.at(-1);
      if (!last) throw new DiffSyntaxError('a “No newline” marker before any line.');
      last.noEol = true;
      continue;
    }
    if (oldLeft === 0 && newLeft === 0) break;
    // An empty line is an empty context line (git's diff.suppressBlankEmpty).
    const kind = line === '' ? ' ' : line[0];
    const text = line.slice(1);
    if (kind === ' ' && oldLeft > 0 && newLeft > 0) {
      parsed.push({ kind, text, noEol: false, oldLine: oldLine++, newLine: newLine++ });
      oldLeft--;
      newLeft--;
    } else if (kind === '-' && oldLeft > 0) {
      parsed.push({ kind, text, noEol: false, oldLine: oldLine++ });
      oldLeft--;
    } else if (kind === '+' && newLeft > 0) {
      parsed.push({ kind, text, noEol: false, newLine: newLine++ });
      newLeft--;
    } else {
      throw new DiffSyntaxError(`a hunk does not match its line counts (“${line.slice(0, 60)}”).`);
    }
  }
  if (oldLeft > 0 || newLeft > 0) throw new DiffSyntaxError('a hunk ends early.');
  const section = range[5] ?? '';
  return [{ oldStart, oldCount, newStart, newCount, section, lines: parsed }, i];
}
