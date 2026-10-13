import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { create } from 'zustand';
import type { ChangedFile, FileStatus, SubmoduleChange } from '../../../shared/models';
import { Icon } from '../../components/Icon';
import { shortSha } from '../../graph/format';
import styles from './FileList.module.css';
import { scrollParent, useViewWindow } from './viewWindow';

const STATUS: Record<FileStatus, { label: string; className: string; title: string }> = {
  A: { label: 'A', className: styles.added!, title: 'Added' },
  M: { label: 'M', className: styles.modified!, title: 'Modified' },
  D: { label: 'D', className: styles.deleted!, title: 'Deleted' },
  R: { label: 'R', className: styles.renamed!, title: 'Renamed' },
  C: { label: 'C', className: styles.renamed!, title: 'Copied' },
  T: { label: 'T', className: styles.modified!, title: 'Type changed' },
  U: { label: '!', className: styles.conflict!, title: 'Conflict' },
  X: { label: '?', className: styles.modified!, title: 'Unknown' },
};
/** Not tracked by git yet (shown as VS Code's Source Control shows it). */
const UNTRACKED = { label: 'U', className: styles.untracked!, title: 'Untracked' };

/** List or tree presentation, shared by every file list and remembered across reloads. */
const usePresentation = create<{ tree: boolean; toggle(): void }>((set, get) => ({
  tree: readTreePreference(),
  toggle() {
    const tree = !get().tree;
    set({ tree });
    try {
      localStorage.setItem('lanefold.fileTree', tree ? '1' : '0');
    } catch {
      // Storage may be unavailable; the choice then lasts for this session only.
    }
  },
}));

function readTreePreference(): boolean {
  try {
    return localStorage.getItem('lanefold.fileTree') === '1';
  } catch {
    return false;
  }
}

export function totals(files: readonly ChangedFile[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? { dir: '', name: path } : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

/** Additions/deletions as a small proportional bar (log-scaled against the largest file). */
function DiffBar({ file, scale }: { file: ChangedFile; scale: number }) {
  if (file.binary) return <span className={styles.binary}>binary</span>;
  const total = file.additions + file.deletions;
  // No line changes (a pure rename or mode change, or an untracked file): keep the column, skip the bar.
  if (total === 0) return <span className={styles.stat} aria-hidden="true" style={{ width: 36 }} />;
  const width = Math.max(3, Math.round((Math.log1p(total) / scale) * 36));
  const added = Math.round((file.additions / total) * width);
  return (
    <span className={styles.stat} title={`${file.additions} additions, ${file.deletions} deletions`}>
      <span className={styles.numbers}>
        {file.additions > 0 ? <span className={styles.plus}>+{file.additions}</span> : null}
        {file.deletions > 0 ? <span className={styles.minus}>−{file.deletions}</span> : null}
      </span>
      <span className={styles.bar} style={{ width: 36 }}>
        <span className={styles.barAdded} style={{ width: added }} />
        <span className={styles.barDeleted} style={{ width: width - added }} />
      </span>
    </span>
  );
}

/**
 * A submodule records a commit, not contents: the commits it moved between ("a1b2c3d4 → e5f6a7b8"),
 * or, in a conflict, the current and the incoming side's.
 */
function SubmoduleRange({ change, conflicted }: { change: SubmoduleChange; conflicted: boolean }) {
  const { from, to, modified, untracked } = change;
  const range =
    from && to
      ? from === to
        ? shortSha(to)
        : `${shortSha(from)} → ${shortSha(to)}`
      : to
        ? `new at ${shortSha(to)}`
        : from
          ? `was ${shortSha(from)}`
          : '';
  const inside = [modified ? 'edited' : '', untracked ? 'new' : ''].filter(Boolean).join(' and ');
  const title = [
    conflicted
      ? `Conflict: the current side records ${from ?? 'no commit'}, the incoming side ${to ?? 'no commit'}`
      : from && to && from !== to
        ? `Submodule moved from ${from} to ${to}`
        : `Submodule at ${to ?? from ?? '?'}`,
    inside ? `${inside} files inside it (not committed there)` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={styles.submodule} title={title}>
      {range}
      {inside ? <span className={styles.inside}>{inside} files</span> : null}
    </span>
  );
}

interface TreeNode {
  readonly name: string;
  readonly path: string;
  /** Folders first, then files, by name. */
  readonly children: readonly TreeNode[];
  readonly file?: ChangedFile;
}

const collator = new Intl.Collator();

/** Folder tree with single-child folder chains compressed ("src/core/git"), sorted once. */
function buildTree(files: readonly ChangedFile[]): TreeNode {
  interface Draft {
    readonly name: string;
    readonly path: string;
    readonly children: Map<string, Draft>;
    file?: ChangedFile;
  }
  const root: Draft = { name: '', path: '', children: new Map() };
  for (const file of files) {
    let node = root;
    for (const part of file.path.split('/')) {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: node.path ? `${node.path}/${part}` : part, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.file = file;
  }
  const finish = (node: Draft, top: boolean): TreeNode => {
    let current = node;
    let name = node.name;
    while (!top && !current.file && current.children.size === 1) {
      const only = current.children.values().next().value!;
      if (only.file) break;
      name = `${name}/${only.name}`;
      current = only;
    }
    const children = [...current.children.values()]
      .map((child) => finish(child, false))
      .sort((a, b) => Number(!!a.file) - Number(!!b.file) || collator.compare(a.name, b.name));
    return { name, path: current.path, children, file: current.file };
  };
  return finish(root, true);
}

/** One row of the list: a file, or (in tree mode) a folder. */
type Row =
  | { readonly kind: 'file'; readonly key: string; readonly file: ChangedFile; readonly depth: number }
  | { readonly kind: 'folder'; readonly key: string; readonly node: TreeNode; readonly depth: number };

/** The tree's rows in display order; a collapsed folder hides what is in it. */
function treeRows(root: TreeNode, collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const visit = (node: TreeNode, depth: number) => {
    for (const child of node.children) {
      if (child.file) rows.push({ kind: 'file', key: `f${child.file.path}`, file: child.file, depth });
      else {
        rows.push({ kind: 'folder', key: `d${child.path}`, node: child, depth });
        if (!collapsed.has(child.path)) visit(child, depth + 1);
      }
    }
  };
  visit(root, 0);
  return rows;
}

/** Every row is this tall (`.row`) unless it is expanded. */
const ROW_HEIGHT = 24;
/** The list's padding above its first row (`.list`). */
const LIST_PADDING = 2;
/** Lists up to this long render every row; longer ones only those near the view. */
const RENDER_ALL = 120;
/** How far beyond the view rows are rendered (px): scrolling and Tab stay ahead of the window. */
const OVERSCAN = 720;
/** What an expanded row is taken to measure until it has been seen. */
const EXPANDED_GUESS = ROW_HEIGHT + 240;

/** Where each row starts: rows are ROW_HEIGHT tall, but expanded ones (measured, or guessed). */
class RowLayout {
  constructor(
    readonly count: number,
    /** Rows taller than ROW_HEIGHT, by index (ascending), and by how much. */
    private readonly extras: readonly (readonly [number, number])[],
  ) {}

  top(index: number): number {
    let top = index * ROW_HEIGHT;
    for (const [at, extra] of this.extras) {
      if (at >= index) break;
      top += extra;
    }
    return top;
  }

  /** The row at `offset` (the first or last one beyond the ends). */
  indexAt(offset: number): number {
    let low = 0;
    let high = this.count - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.top(middle) <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }
}

export interface FileListProps {
  readonly files: readonly ChangedFile[];
  readonly onOpen: (file: ChangedFile) => void;
  readonly onContextMenu?: (file: ChangedFile, event: MouseEvent) => void;
  /** Extra content at the end of a row (e.g. how many selected commits touch the file). */
  readonly badge?: (file: ChangedFile) => ReactNode;
  /** Buttons shown over the end of a row on hover or focus (stage, discard…). */
  readonly actions?: (file: ChangedFile) => ReactNode;
  /** Files to make stand out (the file whose history a view follows). */
  readonly emphasize?: (file: ChangedFile) => boolean;
  readonly emptyText?: string;
  /** The files are untracked (new files git does not know yet). */
  readonly untracked?: boolean;
  /** Rows that expand to show more under them (the file's diff). */
  readonly expansion?: FileExpansion;
}

/** Rows that expand (a chevron, or → and ← on the row) to show something under them. */
export interface FileExpansion {
  readonly isExpanded: (file: ChangedFile) => boolean;
  readonly toggle: (file: ChangedFile) => void;
  /** What shows under the row while it is expanded. */
  readonly render: (file: ChangedFile) => ReactNode;
}

/** Where a row is in the list, for screen readers, and the room the rows skipped before it take. */
interface Placement {
  readonly index: number;
  readonly count: number;
  /** aria-level: how deep in the tree (tree mode only). */
  readonly level?: number;
  /** The height of the rows before it that are not rendered (they are far from the view). */
  readonly gap: number;
  readonly rowKey: string;
}

/** The listitem every row is: its place in the list, and the gap of the rows skipped before it. */
function itemProps({ index, count, level, gap, rowKey }: Placement) {
  return {
    role: 'listitem',
    'aria-posinset': index + 1,
    'aria-setsize': count,
    'aria-level': level,
    'data-index': index,
    'data-key': rowKey,
    style: gap ? { marginTop: gap } : undefined,
  } as const;
}

const FileRow = memo(function FileRow({
  file,
  depth,
  showDir,
  scale,
  props,
  observe,
  ...placement
}: Placement & {
  file: ChangedFile;
  depth: number;
  showDir: boolean;
  scale: number;
  props: FileListProps;
  /** Measures the row while it is expanded (its height varies); returns the way to stop. */
  observe: (element: HTMLElement) => () => void;
}) {
  const status = props.untracked ? UNTRACKED : (STATUS[file.status] ?? STATUS.X);
  const { dir, name } = splitPath(file.path);
  // A submodule has no lines to show under its row (its changes are commits of its own, which
  // opening it shows): no chevron, but the room for one, so the rows stay aligned.
  const expansion = file.submodule ? undefined : props.expansion;
  const expanded = expansion?.isExpanded(file) ?? false;
  const itemRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () => (expanded && itemRef.current ? observe(itemRef.current) : undefined),
    [expanded, observe],
  );
  const button = (
    <button
      type="button"
      data-main
      className={styles.row}
      data-emphasized={props.emphasize?.(file) || undefined}
      style={{ paddingLeft: 8 + depth * 14 + (props.expansion ? 16 : 0) }}
      onClick={() => props.onOpen(file)}
      onContextMenu={(event) => {
        if (!props.onContextMenu) return;
        event.preventDefault();
        props.onContextMenu(file, event);
      }}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
    >
      <span className={[styles.status, status.className].join(' ')} title={status.title}>
        {status.label}
      </span>
      {file.submodule ? (
        <Icon name="file-submodule" className={styles.submoduleIcon} title="Submodule" />
      ) : null}
      <span className={styles.name}>{name}</span>
      {file.oldPath && file.status === 'R' ? (
        <span className={styles.renamedFrom}>
          ← {splitPath(file.oldPath).dir === dir ? splitPath(file.oldPath).name : file.oldPath}
        </span>
      ) : null}
      {showDir && dir ? <span className={styles.dir}>{dir}</span> : <span className={styles.flex} />}
      {props.badge?.(file)}
      {file.submodule ? (
        <SubmoduleRange change={file.submodule} conflicted={file.status === 'U'} />
      ) : (
        <DiffBar file={file} scale={scale} />
      )}
    </button>
  );

  return (
    <div
      ref={itemRef}
      className={styles.item}
      data-expanded={expanded || undefined}
      {...itemProps(placement)}
    >
      {!props.actions && !expansion ? (
        button
      ) : (
        <div className={styles.line}>
          {expansion ? (
            <button
              type="button"
              className={styles.chevron}
              style={{ left: 2 + depth * 14 }}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} changes in ${name}`}
              title={expanded ? 'Hide the changes' : 'Show the changes here'}
              onClick={() => expansion.toggle(file)}
            >
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
            </button>
          ) : null}
          {button}
          {props.actions ? <span className={styles.actions}>{props.actions(file)}</span> : null}
        </div>
      )}
      {expanded && expansion ? expansion.render(file) : null}
    </div>
  );
});

const FolderRow = memo(function FolderRow({
  node,
  depth,
  open,
  onToggle,
  ...placement
}: Placement & {
  node: TreeNode;
  depth: number;
  open: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <div className={styles.item} {...itemProps(placement)}>
      <button
        type="button"
        data-main
        className={[styles.row, styles.folder].join(' ')}
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-expanded={open}
        title={node.path}
        onClick={() => onToggle(node.path)}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} />
        <Icon name="folder" className={styles.folderIcon} />
        <span className={styles.name}>{node.name}</span>
      </button>
    </div>
  );
});

/** A small icon button for a file row's actions. */
export function FileAction({
  icon,
  label,
  name,
  onClick,
  danger,
}: {
  icon: string;
  label: string;
  /** Its accessible name, when the label needs the file it acts on ("Stage src/app.ts"). */
  name?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={[styles.action, danger ? styles.actionDanger : ''].join(' ')}
      title={label}
      aria-label={name ?? label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <Icon name={icon} />
    </button>
  );
}

/**
 * Changed files with status, rename source and a diffstat bar, as a list or a folder tree; click
 * opens the diff. Every row is a listitem (folders too, with their depth). A long list renders
 * only the rows near the view of the pane it scrolls in, and the row with focus: the rows it
 * skips keep their room as a gap, so the pane scrolls as if they were all there. ↑ ↓ Home End
 * and Page keys move between rows (rendering them first); → and ← open and close folders and
 * expandable rows.
 */
export function FileList(props: FileListProps) {
  const { files, expansion } = props;
  const tree = usePresentation((state) => state.tree);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // A loop, not Math.max(...spread): commits can change more files than a call takes arguments.
  const scale = useMemo(
    () => files.reduce((max, f) => Math.max(max, Math.log1p(f.additions + f.deletions)), 1),
    [files],
  );
  const root = useMemo(() => (tree ? buildTree(files) : undefined), [tree, files]);
  const rows = useMemo<Row[]>(
    () =>
      root
        ? treeRows(root, collapsed)
        : files.map((file) => ({ kind: 'file', key: `f${file.path}`, file, depth: 0 })),
    [root, collapsed, files],
  );
  const indexOf = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const windowed = rows.length > RENDER_ALL;
  const listRef = useRef<HTMLDivElement>(null);

  // The part of the list in view of the pane, followed as it scrolls.
  const view = useViewWindow(listRef, windowed, LIST_PADDING);

  // Expanded rows are measured: their height decides where the rows after them are.
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [observer] = useState(
    () =>
      new ResizeObserver((entries) => {
        const seen = entries.flatMap((entry) => {
          const element = entry.target as HTMLElement;
          const key = element.dataset.key;
          return key === undefined || element.offsetHeight === 0
            ? []
            : [[key, element.offsetHeight] as const];
        });
        setHeights((current) => {
          if (seen.every(([key, height]) => current.get(key) === height)) return current;
          const next = new Map(current);
          for (const [key, height] of seen) next.set(key, height);
          return next;
        });
      }),
  );
  useEffect(() => () => observer.disconnect(), [observer]);
  const observe = useCallback(
    (element: HTMLElement) => {
      observer.observe(element);
      return () => observer.unobserve(element);
    },
    [observer],
  );
  const layout = useMemo(() => {
    const extras: [number, number][] = [];
    if (expansion && windowed) {
      rows.forEach((row, index) => {
        if (row.kind === 'file' && expansion.isExpanded(row.file))
          extras.push([index, (heights.get(row.key) ?? EXPANDED_GUESS) - ROW_HEIGHT]);
      });
    }
    return new RowLayout(rows.length, extras);
  }, [rows, expansion, windowed, heights]);

  // The row with focus stays rendered wherever the view goes; arrows move it (rendering the next).
  const [focusKey, setFocusKey] = useState<string>();
  const pendingFocus = useRef<string | undefined>(undefined);
  const mainButton = (index: number) =>
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"] [data-main]`) ?? null;
  const focusRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const button = mainButton(index);
    if (button) {
      button.focus({ preventScroll: true });
      button.scrollIntoView({ block: 'nearest' });
      return;
    }
    pendingFocus.current = row.key;
    setFocusKey(row.key);
  };
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    const index = key === undefined ? undefined : indexOf.get(key);
    const button = index === undefined ? null : mainButton(index);
    if (key !== undefined && (index === undefined || button)) pendingFocus.current = undefined;
    if (!button) return;
    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: 'nearest' });
  });

  const toggleFolder = useCallback(
    (path: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
    [],
  );

  if (files.length === 0) return <div className={styles.empty}>{props.emptyText ?? 'No changes'}</div>;

  let shown: number[];
  if (!windowed) shown = rows.map((_, index) => index);
  else {
    const first = layout.indexAt(view.top - OVERSCAN);
    const last = layout.indexAt(view.bottom + OVERSCAN);
    shown = [];
    for (let index = first; index <= last; index++) shown.push(index);
    const focused = focusKey === undefined ? undefined : indexOf.get(focusKey);
    if (focused !== undefined && (focused < first || focused > last)) {
      shown.push(focused);
      shown.sort((a, b) => a - b);
    }
  }

  /** The row before `index` that holds it: its folder. */
  const parentOf = (index: number): number | undefined => {
    const depth = rows[index]!.depth;
    for (let at = index - 1; at >= 0 && depth > 0; at--) if (rows[at]!.depth === depth - 1) return at;
    return undefined;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.hasAttribute('data-main') || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = Number(target.closest<HTMLElement>('[data-index]')?.dataset.index);
    const row = rows[index];
    if (!row) return;
    const page = Math.max(
      1,
      Math.floor(
        (listRef.current ? (scrollParent(listRef.current)?.clientHeight ?? 480) : 480) / ROW_HEIGHT,
      ) - 1,
    );
    let next: number | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = index + 1;
        break;
      case 'ArrowUp':
        next = index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rows.length - 1;
        break;
      case 'PageDown':
        next = index + page;
        break;
      case 'PageUp':
        next = index - page;
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        // As in a tree: → opens (then steps in), ← closes (then steps out to the folder).
        const open = event.key === 'ArrowRight';
        const isOpen =
          row.kind === 'folder' ? !collapsed.has(row.node.path) : (expansion?.isExpanded(row.file) ?? false);
        const canOpen = row.kind === 'folder' || !!expansion;
        if (canOpen && isOpen !== open) {
          event.preventDefault();
          if (row.kind === 'folder') toggleFolder(row.node.path);
          else expansion?.toggle(row.file);
          return;
        }
        next = open
          ? row.kind === 'folder' && rows[index + 1]?.depth === row.depth + 1
            ? index + 1
            : undefined
          : parentOf(index);
        break;
      }
      default:
        return;
    }
    if (next === undefined) return;
    event.preventDefault();
    const clamped = Math.max(0, Math.min(rows.length - 1, next));
    if (clamped !== index) focusRow(clamped);
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('[data-key]')?.dataset.key;
    if (key !== undefined) setFocusKey(key);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusKey(undefined);
  };

  const items: ReactNode[] = [];
  /** The first row not yet accounted for: the rows from it up to the next one shown are skipped. */
  let after = 0;
  for (const index of shown) {
    const row = rows[index]!;
    // Primitive props, so a row renders again only when it changed (not on every scroll step).
    const placement: Placement = {
      index,
      count: rows.length,
      level: root ? row.depth + 1 : undefined,
      gap: layout.top(index) - layout.top(after),
      rowKey: row.key,
    };
    after = index + 1;
    items.push(
      row.kind === 'file' ? (
        <FileRow
          key={row.key}
          file={row.file}
          depth={row.depth}
          showDir={!root}
          scale={scale}
          props={props}
          observe={observe}
          {...placement}
        />
      ) : (
        <FolderRow
          key={row.key}
          node={row.node}
          depth={row.depth}
          open={!collapsed.has(row.node.path)}
          onToggle={toggleFolder}
          {...placement}
        />
      ),
    );
  }
  const rest = layout.top(rows.length) - layout.top(after);
  return (
    <div
      ref={listRef}
      className={styles.list}
      role="list"
      style={rest > 0 ? { paddingBottom: LIST_PADDING + rest } : undefined}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {items}
    </div>
  );
}

/** The list/tree switch for a file section header. */
export function TreeToggle() {
  const { tree, toggle } = usePresentation();
  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={toggle}
      title={tree ? 'View as list' : 'View as tree'}
      aria-label={tree ? 'View as list' : 'View as tree'}
    >
      <Icon name={tree ? 'list-flat' : 'list-tree'} />
    </button>
  );
}
