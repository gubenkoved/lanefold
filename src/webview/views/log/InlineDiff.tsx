import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { create } from 'zustand';
import {
  linesLabel,
  type DiffArea,
  type DiffHunk,
  type DiffLine,
  type FileHunks,
  type LineRef,
  type LineSelection,
} from '../../../shared/hunks';
import type { ChangedFile } from '../../../shared/models';
import { errorText } from '../../bridge/errorText';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { useHost } from '../../hostContext';
import { changeIndex } from '../../state/indexChanges';
import { runOperation, useOperations } from '../../state/operations';
import { copyText, useQuery, useRepoVersion } from '../../state/queries';
import type { FileExpansion } from './FileList';
import { ErrorLine, LoadingLine } from './parts';
import { useViewWindow } from './viewWindow';
import styles from './InlineDiff.module.css';

/** The uncommitted-changes groups whose files can show their diff inline. */
export type InlineGroup = 'staged' | 'changes' | 'untracked';

const AREAS: Record<InlineGroup, DiffArea> = {
  staged: 'staged',
  changes: 'unstaged',
  untracked: 'untracked',
};

/** Files showing their diff under their row ("repo, group, path"), for as long as the view lives. */
const useExpanded = create<{ keys: ReadonlySet<string>; toggle(key: string): void }>((set, get) => ({
  keys: new Set(),
  toggle(key) {
    const keys = new Set(get().keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    set({ keys });
  },
}));

/**
 * Lets the files of an uncommitted-changes group expand to show their diff, where hunks and
 * lines can be staged, unstaged or discarded. `open` opens a file in the diff editor.
 */
export function useInlineDiffs(
  repoId: string,
): (group: InlineGroup, open: (file: ChangedFile) => void) => FileExpansion {
  const keys = useExpanded((state) => state.keys);
  const toggle = useExpanded((state) => state.toggle);
  return (group, open) => {
    const key = (file: ChangedFile) => `${repoId}\0${group}\0${file.path}`;
    return {
      isExpanded: (file) => keys.has(key(file)),
      toggle: (file) => toggle(key(file)),
      render: (file) => (
        <InlineDiff repoId={repoId} file={file} area={AREAS[group]} onOpen={() => open(file)} />
      ),
    };
  };
}

interface InlineDiffProps {
  readonly repoId: string;
  readonly file: ChangedFile;
  readonly area: DiffArea;
  /** Opens the file's changes in the diff editor. */
  readonly onOpen: () => void;
}

/**
 * The diffs shown last, by file: shown again at once when a row comes back into a long list (or
 * is expanded again) while the diff is read anew. Actions name the fingerprint, so a stale one is
 * refused, never acted on.
 */
const shownDiffs = new Map<string, FileHunks>();
const SHOWN_DIFFS = 64;

/** Whether the person has picked lines before: the hint under each diff is shown until then. */
const usePicked = create<{ picked: boolean; pick(): void }>((set, get) => ({
  picked: readPicked(),
  pick() {
    if (get().picked) return;
    set({ picked: true });
    try {
      localStorage.setItem('lanefold.pickedLines', '1');
    } catch {
      // Not remembered across reloads; fine.
    }
  },
}));

function readPicked(): boolean {
  try {
    return localStorage.getItem('lanefold.pickedLines') === '1';
  } catch {
    return false;
  }
}

/** One file's diff under its row: hunks and lines to stage, unstage or discard. */
export function InlineDiff({ repoId, file, area, onOpen }: InlineDiffProps) {
  const host = useHost();
  // Staging, edits and Undo change the diff: read it again (the selection then starts over).
  const version = useRepoVersion(host.rpc, repoId, ['index', 'worktree']);
  const [reload, setReload] = useState(0);
  const key = `${repoId}\0${area}\0${file.path}`;
  const diff = useQuery(`${key}\0${version}\0${reload}`, (signal) =>
    host.rpc.call('diff.hunks', { repoId, path: file.path, area }, { signal }),
  );
  useEffect(() => {
    if (!diff.data) return;
    shownDiffs.delete(key);
    shownDiffs.set(key, diff.data);
    while (shownDiffs.size > SHOWN_DIFFS) shownDiffs.delete(shownDiffs.keys().next().value!);
  }, [key, diff.data]);
  const data = diff.data ?? (diff.error ? undefined : shownDiffs.get(key));
  if (!data) {
    return (
      <div className={styles.root}>
        {diff.error ? <ErrorLine error={diff.error} /> : <LoadingLine text="Loading the changes…" />}
      </div>
    );
  }
  return <DiffView repoId={repoId} diff={data} onOpen={onOpen} onStale={() => setReload((n) => n + 1)} />;
}

/** A selection of changed lines, by position among the diff's added and removed lines. */
interface Selection {
  /** The diff it belongs to: positions mean nothing in another one. */
  readonly fingerprint: string;
  readonly lines: ReadonlySet<number>;
  /** Where Shift+click and Shift+arrows extend from. */
  readonly anchor?: number;
  /** The line the arrow keys move from. */
  readonly cursor?: number;
}

const NOTHING: ReadonlySet<number> = new Set();

const range = (from: number, to: number): Set<number> => {
  const lines = new Set<number>();
  for (let n = Math.min(from, to); n <= Math.max(from, to); n++) lines.add(n);
  return lines;
};

/** What can be done with the whole file in each area. */
const WHOLE: Record<DiffArea, string> = {
  unstaged: 'staged or discarded',
  staged: 'unstaged',
  untracked: 'staged or deleted',
};

function DiffView({
  repoId,
  diff,
  onOpen,
  onStale,
}: {
  repoId: string;
  diff: FileHunks;
  onOpen: () => void;
  onStale: () => void;
}) {
  const host = useHost();
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dragging = useRef(false);
  /**
   * An action ran from here. Once the diff it changed is shown, focus goes back to the lines if it
   * was started from the keyboard (to go on picking), or wherever it can if it was lost.
   */
  const refocus = useRef<'lines' | 'ifLost' | undefined>(undefined);
  const shown = useRef(diff.fingerprint);
  const [busy, setBusy] = useState(false);
  /** The diff an action ran on: its buttons wait for the diff that action made (no double staging). */
  const [actedOn, setActedOn] = useState<string>();
  useEffect(() => {
    if (actedOn === undefined) return;
    // Should the new diff never come (a missed event), the buttons work again after a while.
    const timer = setTimeout(() => setActedOn(undefined), 4000);
    return () => clearTimeout(timer);
  }, [actedOn]);
  const starting = useOperations((state) => !!state.starting || !!state.sheet?.running);
  const picked = usePicked((state) => state.picked);
  const pick = usePicked((state) => state.pick);
  const readOnly = !!diff.wholeFile;

  // Each added or removed line's position among them, and back.
  const index = useMemo(() => {
    const refs: LineRef[] = [];
    const ordinals = diff.hunks.map((hunk, h) =>
      hunk.lines.map((line, l) => (line.kind === 'context' ? -1 : refs.push({ hunk: h, line: l }) - 1)),
    );
    return { refs, ordinals };
  }, [diff]);
  const count = index.refs.length;

  const [state, setState] = useState<Selection>({ fingerprint: diff.fingerprint, lines: NOTHING });
  let selection = state;
  if (state.fingerprint !== diff.fingerprint) {
    // Another diff (lines were staged, the file was edited): start over, the cursor about where it was.
    selection = {
      fingerprint: diff.fingerprint,
      lines: NOTHING,
      cursor: state.cursor === undefined || count === 0 ? undefined : Math.min(state.cursor, count - 1),
    };
    setState(selection);
  }
  const { lines: selected, cursor } = selection;
  const update = (change: (current: Selection) => Omit<Selection, 'fingerprint'>) =>
    setState((current) => ({ fingerprint: diff.fingerprint, ...change(current) }));

  // The cursor's hunk has focus while the keyboard is in the diff, and its line is in view.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (cursor === undefined || !root) return;
    const ref = index.refs[cursor];
    const list = ref && listRefs.current[ref.hunk];
    if (!ref || !list) return;
    if (root.contains(document.activeElement) && document.activeElement !== list) {
      if (document.activeElement?.getAttribute('role') === 'listbox') list.focus({ preventScroll: true });
    }
    if (list === document.activeElement)
      document.getElementById(`${id}-${ref.hunk}-${ref.line}`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor, index, id]);

  // After an action the diff changes, and the button pressed may be gone.
  useEffect(() => {
    if (shown.current === diff.fingerprint) return;
    shown.current = diff.fingerprint;
    const how = refocus.current;
    refocus.current = undefined;
    const root = rootRef.current;
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (!how || !root || !(lost || (how === 'lines' && root.contains(active)))) return;
    const ref = index.refs[cursor ?? 0] ?? index.refs[0];
    (listRefs.current[ref?.hunk ?? 0] ?? root).focus({ preventScroll: true });
  }, [diff.fingerprint, cursor, index]);

  useEffect(() => {
    const stop = () => (dragging.current = false);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  const lineSelection = (): LineSelection => ({
    lines: [...selected].sort((a, b) => a - b).map((ordinal) => index.refs[ordinal]!),
  });

  const rememberFocus = () => {
    const active = document.activeElement;
    refocus.current =
      !active || !rootRef.current?.contains(active)
        ? undefined
        : active.matches(':focus-visible')
          ? 'lines'
          : 'ifLost';
  };

  const stageOrUnstage = async (what: LineSelection) => {
    rememberFocus();
    setBusy(true);
    const { path, area, fingerprint } = diff;
    try {
      await changeIndex(
        repoId,
        area === 'staged'
          ? host.rpc.call('index.unstageLines', { repoId, path, area, fingerprint, selection: what })
          : host.rpc.call('index.stageLines', { repoId, path, area, fingerprint, selection: what }),
      );
      setActedOn(fingerprint);
    } catch (error) {
      refocus.current = undefined;
      const stale = (error as { code?: unknown }).code === 'stale';
      toast(area === 'staged' ? 'Could not unstage' : 'Could not stage', {
        kind: 'error',
        detail: errorText(error),
      });
      if (stale) onStale();
    } finally {
      setBusy(false);
    }
  };

  const discard = (what: LineSelection) => {
    rememberFocus();
    const { fingerprint } = diff;
    void runOperation(
      { kind: 'discardLines', path: diff.path, fingerprint, selection: what },
      { onDone: (result) => result.status === 'done' && setActedOn(fingerprint) },
    );
  };

  const select = (ordinal: number, how: 'only' | 'toggle' | 'extend') => {
    pick();
    update((current) => {
      if (how === 'extend') {
        const anchor = current.anchor ?? current.cursor ?? ordinal;
        return { lines: range(anchor, ordinal), anchor, cursor: ordinal };
      }
      if (how === 'toggle') {
        const lines = new Set(current.lines);
        if (lines.has(ordinal)) lines.delete(ordinal);
        else lines.add(ordinal);
        return { lines, anchor: ordinal, cursor: ordinal };
      }
      return { lines: new Set([ordinal]), anchor: ordinal, cursor: ordinal };
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>, ordinal: number, hunk: number) => {
    if (event.button !== 0 || readOnly) return;
    // Lines are picked, not text: no text selection, focus where the keyboard continues.
    event.preventDefault();
    listRefs.current[hunk]?.focus({ preventScroll: true });
    if (event.shiftKey) select(ordinal, 'extend');
    else if (event.ctrlKey || event.metaKey) select(ordinal, 'toggle');
    else {
      select(ordinal, 'only');
      dragging.current = true;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, hunk: number) => {
    if (count === 0) return;
    const here = cursor ?? index.ordinals[hunk]!.find((ordinal) => ordinal >= 0) ?? 0;
    // Read-only diffs (whole-file actions only) can still be read line by line.
    const choose = !readOnly;
    const move = (to: number) => {
      const target = Math.max(0, Math.min(count - 1, to));
      if (event.shiftKey && choose) select(target, 'extend');
      else update((current) => ({ ...current, cursor: target }));
    };
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'ArrowDown') move(here + 1);
    else if (event.key === 'ArrowUp') move(here - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(count - 1);
    else if (event.key === ' ' && choose) select(here, 'toggle');
    else if (event.key === 'Escape' && selected.size > 0)
      update((current) => ({ ...current, lines: NOTHING }));
    else if (mod && event.key.toLowerCase() === 'a' && choose)
      update((current) => ({ ...current, lines: range(0, count - 1) }));
    else if (mod && event.key.toLowerCase() === 'c') {
      const ordinals = selected.size > 0 ? [...selected].sort((a, b) => a - b) : [here];
      const text = ordinals.map((ordinal) => {
        const ref = index.refs[ordinal]!;
        return diff.hunks[ref.hunk]!.lines[ref.line]!.text;
      });
      void copyText(`${text.join('\n')}\n`);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onFocus = (hunk: number) => {
    // Tabbing into a hunk puts the cursor on its first change (unless it is there already).
    const inside = cursor !== undefined && index.refs[cursor]?.hunk === hunk;
    const first = index.ordinals[hunk]!.find((ordinal) => ordinal >= 0);
    if (!inside && first !== undefined) update((current) => ({ ...current, cursor: first }));
  };

  const name = diff.path.slice(diff.path.lastIndexOf('/') + 1);
  const note = noteFor(diff);
  const width = useMemo(
    () =>
      String(
        diff.hunks.reduce(
          (max, hunk) => Math.max(max, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount),
          1,
        ),
      ).length,
    [diff],
  );
  const disabled = busy || starting || actedOn === diff.fingerprint;
  const hint =
    selected.size > 0
      ? `${linesLabel(selected.size)} selected · Esc clears`
      : !picked && count > 1
        ? 'Pick lines: click, Shift+click or drag (Space from the keyboard).'
        : undefined;

  return (
    <div
      ref={rootRef}
      className={styles.root}
      role="group"
      aria-label={`Changes in ${name}`}
      tabIndex={-1}
      style={{ '--digits': width } as CSSProperties}
    >
      {note ? (
        <div className={styles.note}>
          <Icon name={diff.wholeFile === 'binary' ? 'file-binary' : 'info'} />
          <span>
            {note} {diff.wholeFile ? `It can only be ${WHOLE[diff.area]} as a whole.` : null}{' '}
            <button type="button" className={styles.link} onClick={onOpen}>
              Open in diff editor
            </button>
          </span>
        </div>
      ) : null}
      {diff.hunks.map((hunk, h) => (
        <Hunk
          key={h}
          id={id}
          hunk={hunk}
          index={h}
          total={diff.hunks.length}
          area={diff.area}
          readOnly={readOnly}
          ordinals={index.ordinals[h]!}
          selected={selected}
          cursor={cursor}
          disabled={disabled}
          listRef={(element) => {
            listRefs.current[h] = element;
          }}
          onPointerDown={onPointerDown}
          onPointerEnter={(ordinal) => dragging.current && select(ordinal, 'extend')}
          onKeyDown={(event) => onKeyDown(event, h)}
          onFocus={() => onFocus(h)}
          onStage={(whole) => void stageOrUnstage(whole ? { hunks: [h] } : lineSelection())}
          onDiscard={(whole) => discard(whole ? { hunks: [h] } : lineSelection())}
        />
      ))}
      {!readOnly && hint ? <div className={styles.hint}>{hint}</div> : null}
    </div>
  );
}

/** Why the diff is not (all) shown, or why it is shown read-only. */
function noteFor(diff: FileHunks): string | undefined {
  switch (diff.wholeFile) {
    case 'binary':
      return 'A binary file: its changes cannot be shown here.';
    case 'tooLarge':
      return `Too many changes to show here (+${diff.additions.toLocaleString()} −${diff.deletions.toLocaleString()}).`;
    case 'renamed':
      return `Renamed from ${diff.renamedFrom ?? 'another path'}.`;
    case 'modeChange': {
      const modes = diff.modes ? ` (${describeModes(diff.modes)})` : '';
      return diff.hunks.length > 0 ? `Its mode changed too${modes}.` : `Only its mode changed${modes}.`;
    }
    case 'submodule':
      return diff.area === 'untracked'
        ? 'A repository of its own (it is added as a submodule).'
        : 'A submodule: its changes are commits of its own.';
    case 'symlink':
      return 'A symbolic link.';
    default:
      if (diff.hunks.length > 0) return undefined;
      if (diff.created || diff.area === 'untracked') return 'An empty file.';
      return diff.deleted ? 'An empty file, deleted.' : 'No changes to show.';
  }
}

/** "100644 → 100755: now executable". */
function describeModes({ from, to }: { readonly from: string; readonly to: string }): string {
  const change = `${from} → ${to}`;
  if (from === '100644' && to === '100755') return `${change}: now executable`;
  if (from === '100755' && to === '100644') return `${change}: no longer executable`;
  return change;
}

const SIGNS: Record<DiffLine['kind'], string> = { context: ' ', added: '+', removed: '-' };

/** Every line is this tall (`.lines`), and the hunk's list has this padding above its first one. */
const LINE_HEIGHT = 18;
const LINES_PADDING = 2;
/** Hunks up to this long render every line; longer ones the lines near the view. */
const ALL_LINES = 240;
/** How far beyond the view lines are rendered (px). */
const LINES_OVERSCAN = 540;

/** "lines 12–20" of the hunk (after the change; before it, when nothing is left). */
function linesOf(hunk: DiffHunk): string {
  const [start, count] = hunk.newCount > 0 ? [hunk.newStart, hunk.newCount] : [hunk.oldStart, hunk.oldCount];
  return count === 1 ? `line ${start}` : `lines ${start}–${start + count - 1}`;
}

/** Screen readers get this much of a line (a minified file's line can be a megabyte). */
const LABEL_TEXT = 300;

function lineLabel(line: DiffLine): string {
  const where =
    line.kind === 'added'
      ? `Added line ${line.newLine}`
      : line.kind === 'removed'
        ? `Removed line ${line.oldLine}`
        : `Line ${line.newLine}`;
  const text = line.text.length > LABEL_TEXT ? `${line.text.slice(0, LABEL_TEXT)}…` : line.text;
  return `${where}${line.noEol ? ', no newline at end of file' : ''}: ${text || '(empty)'}`;
}

/** Leading and trailing whitespace: a change in it alone is otherwise invisible. */
const EDGES = /^([ \t]*)(.*?)([ \t]*)$/s;

/** A line's text with its whitespace evened out (runs as one space, none at the ends). */
const squeeze = (text: string) => text.replace(/[ \t]+/g, ' ').trim();

/**
 * The changed lines of a hunk that differ from a line on the other side in whitespace (or a CRLF
 * line break) only: those show their whitespace, which is the whole change.
 */
function whitespaceChanges(hunk: DiffHunk): boolean[] {
  const removed = new Set<string>();
  const added = new Set<string>();
  for (const line of hunk.lines) {
    if (line.kind === 'removed') removed.add(squeeze(line.text));
    else if (line.kind === 'added') added.add(squeeze(line.text));
  }
  return hunk.lines.map((line) =>
    line.kind === 'removed'
      ? added.has(squeeze(line.text))
      : line.kind === 'added' && removed.has(squeeze(line.text)),
  );
}

/**
 * A line's text; with `whitespace`, the whitespace at its ends is shown (as the editor renders
 * whitespace: · for a space, → for a tab, keeping its width) and so is a CRLF's ␍. `widest`
 * (characters) makes it as wide as the widest line, when not all lines are rendered.
 */
function LineText({ line, whitespace, widest }: { line: DiffLine; whitespace: boolean; widest: number }) {
  const style = widest > 0 ? { minWidth: `${widest + 1}ch` } : undefined;
  if (!whitespace)
    return (
      <span className={styles.text} style={style}>
        {line.text}
      </span>
    );
  const [, lead = '', body = '', trail = ''] = EDGES.exec(line.text) ?? [];
  return (
    <span className={styles.text} style={style}>
      {lead ? <Whitespace text={lead} /> : null}
      {body}
      {trail ? <Whitespace text={trail} /> : null}
      {line.cr ? (
        <span className={styles.whitespace} title="Carriage return (CRLF line break)">
          ␍
        </span>
      ) : null}
    </span>
  );
}

function Whitespace({ text }: { text: string }) {
  return (
    <span className={styles.whitespace}>
      {text.split(/(\t)/).map((part, index) =>
        part === '\t' ? (
          <span key={index} className={styles.tab}>
            {'\t'}
          </span>
        ) : (
          '·'.repeat(part.length)
        ),
      )}
    </span>
  );
}

function Hunk({
  id,
  hunk,
  index,
  total,
  area,
  readOnly,
  ordinals,
  selected,
  cursor,
  disabled,
  listRef,
  onPointerDown,
  onPointerEnter,
  onKeyDown,
  onFocus,
  onStage,
  onDiscard,
}: {
  id: string;
  hunk: DiffHunk;
  index: number;
  total: number;
  area: DiffArea;
  readOnly: boolean;
  ordinals: readonly number[];
  selected: ReadonlySet<number>;
  cursor: number | undefined;
  disabled: boolean;
  listRef: (element: HTMLDivElement | null) => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>, ordinal: number, hunk: number) => void;
  onPointerEnter: (ordinal: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  onStage: (whole: boolean) => void;
  onDiscard: (whole: boolean) => void;
}) {
  const rangeId = `${id}-range-${index}`;
  // With lines selected here, the hunk's actions act on the selection (in every hunk).
  const picked = selected.size > 0 && ordinals.some((ordinal) => ordinal >= 0 && selected.has(ordinal));
  const what = picked ? linesLabel(selected.size) : 'hunk';
  const cursorLine = cursor === undefined ? -1 : ordinals.indexOf(cursor);
  const whitespace = useMemo(() => whitespaceChanges(hunk), [hunk]);

  // A long hunk renders the lines near the view of the pane (and the keyboard's line); the lines
  // it skips keep their room, and every line is as wide as the widest, so scrolling sideways
  // stays the same.
  const linesRef = useRef<HTMLDivElement | null>(null);
  const windowed = hunk.lines.length > ALL_LINES;
  const view = useViewWindow(linesRef, windowed, LINES_PADDING);
  const widest = useMemo(
    () =>
      windowed
        ? hunk.lines.reduce(
            (max, line) => Math.max(max, line.text.length + 3 * (line.text.split('\t').length - 1)),
            0,
          )
        : 0,
    [hunk, windowed],
  );
  const shown: number[] = [];
  const first = windowed ? Math.max(0, Math.floor((view.top - LINES_OVERSCAN) / LINE_HEIGHT)) : 0;
  const last = windowed
    ? Math.min(hunk.lines.length - 1, Math.ceil((view.bottom + LINES_OVERSCAN) / LINE_HEIGHT))
    : hunk.lines.length - 1;
  if (cursorLine >= 0 && cursorLine < first) shown.push(cursorLine);
  for (let l = first; l <= last; l++) shown.push(l);
  if (cursorLine > last) shown.push(cursorLine);
  const rest = (hunk.lines.length - 1 - (shown.at(-1) ?? -1)) * LINE_HEIGHT;
  return (
    <div className={styles.hunk}>
      <div className={styles.bar}>
        <span
          className={styles.range}
          id={rangeId}
          title={`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`}
        >
          @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
        </span>
        <span className={styles.section}>{hunk.section}</span>
        {readOnly ? null : (
          <span className={styles.actions}>
            {area === 'unstaged' ? (
              <HunkAction
                icon="discard"
                label={`Discard ${what}…`}
                danger
                disabled={disabled}
                describedBy={rangeId}
                onClick={() => onDiscard(!picked)}
              />
            ) : null}
            <HunkAction
              icon={area === 'staged' ? 'remove' : 'add'}
              label={`${area === 'staged' ? 'Unstage' : 'Stage'} ${what}`}
              disabled={disabled}
              describedBy={rangeId}
              onClick={() => onStage(!picked)}
            />
          </span>
        )}
      </div>
      <div
        ref={(element) => {
          linesRef.current = element;
          listRef(element);
        }}
        className={styles.lines}
        role="listbox"
        aria-multiselectable={readOnly ? undefined : true}
        aria-readonly={readOnly || undefined}
        aria-label={`Hunk ${index + 1} of ${total}: ${linesOf(hunk)}${hunk.section ? `, ${hunk.section}` : ''}`}
        aria-activedescendant={cursorLine >= 0 ? `${id}-${index}-${cursorLine}` : undefined}
        tabIndex={0}
        style={rest > 0 ? { paddingBottom: LINES_PADDING + rest } : undefined}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        {shown.map((l, at) => {
          const line = hunk.lines[l]!;
          const ordinal = ordinals[l]!;
          const changed = ordinal >= 0;
          const skipped = l - (at === 0 ? 0 : shown[at - 1]! + 1);
          return (
            <div
              key={l}
              id={`${id}-${index}-${l}`}
              role="option"
              aria-selected={changed && !readOnly ? selected.has(ordinal) : undefined}
              aria-disabled={changed && !readOnly ? undefined : true}
              aria-label={lineLabel(line)}
              className={styles.line}
              data-kind={line.kind}
              data-cursor={(changed && ordinal === cursor) || undefined}
              style={skipped > 0 ? { marginTop: skipped * LINE_HEIGHT } : undefined}
              onPointerDown={changed ? (event) => onPointerDown(event, ordinal, index) : undefined}
              onPointerEnter={changed ? () => onPointerEnter(ordinal) : undefined}
            >
              <span className={styles.gutter} aria-hidden="true">
                <span className={styles.number}>{line.oldLine ?? ''}</span>
                <span className={styles.number}>{line.newLine ?? ''}</span>
                <span className={styles.sign}>{SIGNS[line.kind]}</span>
              </span>
              <LineText line={line} whitespace={whitespace[l]!} widest={widest} />
              {line.noEol ? (
                <span className={styles.noEol} title="No newline at end of file" aria-hidden="true">
                  <Icon name="no-newline" />
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A hunk bar button: its label shrinks to the icon in a narrow pane (the name stays). */
function HunkAction({
  icon,
  label,
  danger,
  disabled,
  describedBy,
  onClick,
}: {
  icon: string;
  label: string;
  danger?: boolean;
  disabled: boolean;
  describedBy: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={[styles.action, danger ? styles.danger : ''].join(' ')}
      title={label}
      aria-label={label}
      aria-describedby={describedBy}
      // Not `disabled`: a focused button that becomes disabled drops focus mid-action.
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      <Icon name={icon} />
      <span className={styles.actionLabel}>{label}</span>
    </button>
  );
}
