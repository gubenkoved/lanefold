import type { LineSelection, WholeFileReason } from '../../shared/hunks';
import { NO_EOL_MARKER, type FilePatch } from '../parsers/unifiedDiff';

/** A patch of some lines of a file's diff, for `git apply`. */
export interface LinePatch {
  /** The patch, one character per byte of git's output ('latin1'). */
  readonly text: string;
  /** Selected lines: added and removed ones. */
  readonly added: number;
  readonly removed: number;
}

/** Why only the whole file's changes can be staged, unstaged or discarded, if so. */
export function wholeFileReason(patch: FilePatch): WholeFileReason | undefined {
  if (patch.binary) return 'binary';
  if (patch.renamed) return 'renamed';
  if (patch.oldMode || patch.newMode) return 'modeChange';
  if (patch.modes.includes('160000')) return 'submodule';
  if (patch.modes.includes('120000')) return 'symlink';
  return undefined;
}

const WHOLE_FILE: Record<WholeFileReason, string> = {
  binary: 'is a binary file',
  tooLarge: 'has too many changes to show',
  renamed: 'was renamed',
  modeChange: 'changed its mode too',
  submodule: 'is a submodule',
  symlink: 'is a symbolic link',
};

/** The refusal of a line action on such a file. */
export function wholeFileMessage(name: string, reason: WholeFileReason): string {
  return `${name} ${WHOLE_FILE[reason]}: only the whole file can be staged, unstaged or discarded.`;
}

/**
 * The selected added and removed lines, as `hunk:line` keys. Refuses positions the diff does not
 * have, and context lines (they are no change of their own).
 */
export function selectedLines(patch: FilePatch, selection: LineSelection): Set<string> {
  const keys = new Set<string>();
  for (const h of selection.hunks ?? []) {
    const hunk = patch.hunks[h];
    if (!hunk) throw new Error(`The diff has no hunk ${h + 1}.`);
    hunk.lines.forEach((line, l) => {
      if (line.kind !== ' ') keys.add(`${h}:${l}`);
    });
  }
  for (const { hunk: h, line: l } of selection.lines ?? []) {
    const line = patch.hunks[h]?.lines[l];
    if (!line) throw new Error(`The diff has no line ${l + 1} in hunk ${h + 1}.`);
    if (line.kind === ' ') throw new Error('Only added or removed lines can be chosen.');
    keys.add(`${h}:${l}`);
  }
  return keys;
}

/** One line of the patch being built: the sides it is on, and where it ends its side without a line break. */
interface Entry {
  readonly text: string;
  readonly old: boolean;
  readonly new: boolean;
  oldNoEol: boolean;
  newNoEol: boolean;
}

/** "12,3", or "12" for one line (as git writes ranges). */
const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);

/**
 * Builds a patch of the selected lines of a file's diff:
 *
 * - forward (`git apply [--cached]`, staging from the unstaged diff): the patch applies to the
 *   diff's "before" side. Selected lines change; an unselected removed line stays (context), an
 *   unselected added line never happened (dropped).
 * - `reverse` (`git apply --reverse`, unstaging from the staged diff or discarding from the
 *   unstaged one): the patch applies to the diff's "after" side. Selected lines are taken back;
 *   an unselected added line stays (context), an unselected removed line is dropped.
 *
 * The side the patch applies to is kept exactly; the other one is computed, and hunk positions
 * account for the lines earlier hunks add or remove. Only the last line of a file can lack a line
 * break: a line that ended the file but no longer does (a line is added after it) gets one,
 * written as a removal and an addition. A new or deleted file stays one only when every line is
 * chosen; otherwise the patch changes the file in place.
 *
 * Returns undefined when nothing is selected.
 */
export function buildLinePatch(
  patch: FilePatch,
  selection: LineSelection,
  reverse: boolean,
): LinePatch | undefined {
  if (patch.files !== 1 || patch.combined)
    throw new Error('Lanefold builds patches for one changed file only.');
  const reason = wholeFileReason(patch);
  if (reason) throw new Error(wholeFileMessage('The file', reason));
  const selected = selectedLines(patch, selection);
  if (selected.size === 0) return undefined;
  const body: string[] = [];
  let added = 0;
  let removed = 0;
  let changes = 0;
  /** Lines the computed side gained (or lost) in the hunks so far. */
  let delta = 0;
  patch.hunks.forEach((hunk, h) => {
    const entries: Entry[] = [];
    let chosen = false;
    hunk.lines.forEach((line, l) => {
      const { text, noEol } = line;
      if (line.kind === ' ') {
        entries.push({ text, old: true, new: true, oldNoEol: noEol, newNoEol: noEol });
        return;
      }
      changes++;
      const isNew = line.kind === '+';
      if (selected.has(`${h}:${l}`)) {
        chosen = true;
        if (isNew) added++;
        else removed++;
        entries.push({ text, old: !isNew, new: isNew, oldNoEol: !isNew && noEol, newNoEol: isNew && noEol });
      } else if (isNew === reverse) {
        // Unselected, on the side the patch applies to: it stays as it is (context).
        entries.push({ text, old: true, new: true, oldNoEol: noEol, newNoEol: noEol });
      }
      // Otherwise (an unselected change on the other side) it never happens as far as the patch goes.
    });
    if (!chosen) return;
    // On the computed side, every line but the last one now has a line break after it.
    const computed = entries.filter((entry) => (reverse ? entry.old : entry.new));
    for (const entry of computed.slice(0, -1)) {
      if (reverse) entry.oldNoEol = false;
      else entry.newNoEol = false;
    }
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (const entry of entries) {
      if (entry.old) oldCount++;
      if (entry.new) newCount++;
      if (entry.old && entry.new && entry.oldNoEol === entry.newNoEol) {
        lines.push(` ${entry.text}`);
        if (entry.oldNoEol) lines.push(NO_EOL_MARKER);
        continue;
      }
      // On both sides, but ending the file on one only: its line break changes.
      if (entry.old) {
        lines.push(`-${entry.text}`);
        if (entry.oldNoEol) lines.push(NO_EOL_MARKER);
      }
      if (entry.new) {
        lines.push(`+${entry.text}`);
        if (entry.newNoEol) lines.push(NO_EOL_MARKER);
      }
    }
    const [keptStart, keptCount, computedCount] = reverse
      ? [hunk.newStart, newCount, oldCount]
      : [hunk.oldStart, oldCount, newCount];
    if (keptCount !== (reverse ? hunk.newCount : hunk.oldCount))
      throw new Error('Lanefold could not build the patch (a hunk does not add up).');
    // Where the hunk starts on the computed side: after the same lines, moved by earlier hunks.
    // (An empty range names the line before it, as git writes it.)
    const first = (keptCount > 0 ? keptStart : keptStart + 1) + delta;
    const computedStart = computedCount > 0 ? first : first - 1;
    delta += computedCount - keptCount;
    const [oldStart, newStart] = reverse ? [computedStart, keptStart] : [keptStart, computedStart];
    body.push(
      `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@${hunk.section ? ` ${hunk.section}` : ''}`,
      ...lines,
    );
  });
  // The blob hashes would not match the partial content, and git does not need them.
  let header = patch.header.filter((line) => !line.startsWith('index '));
  const everything = selected.size === changes;
  // Staging part of a deletion, or taking back part of a new file, leaves the file in place.
  if (patch.created && reverse && !everything) header = inPlace(header, 'created');
  if (patch.deleted && !reverse && !everything) header = inPlace(header, 'deleted');
  return { text: `${[...header, ...body].join('\n')}\n`, added, removed };
}

/**
 * Turns the header of a new (or deleted) file into one that changes the file in place: "---"
 * (or "+++") names the file instead of /dev/null, spelled (and quoted) the way git spelled the
 * other side.
 */
function inPlace(header: readonly string[], kind: 'created' | 'deleted'): string[] {
  const created = kind === 'created';
  const mode = created ? 'new file mode ' : 'deleted file mode ';
  const empty = created ? '--- /dev/null' : '+++ /dev/null';
  const from = created ? ['+++ b/', '+++ "b/'] : ['--- a/', '--- "a/'];
  const to = created ? ['--- a/', '--- "a/'] : ['+++ b/', '+++ "b/'];
  const named = header.find((line) => from.some((start) => line.startsWith(start)));
  const index = named === undefined ? -1 : from.findIndex((start) => named.startsWith(start));
  if (named === undefined || index < 0 || !header.includes(empty))
    throw new Error('Lanefold could not build the patch (unexpected diff header).');
  const replacement = to[index]! + named.slice(from[index]!.length);
  return header.filter((line) => !line.startsWith(mode)).map((line) => (line === empty ? replacement : line));
}
