import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { isHideableRef, type RefInfo, type WorktreeInfo } from '../../../shared/models';
import { relativeLong } from '../../../shared/time';
import { Icon } from '../../components/Icon';
import { openMenu, type MenuEntry } from '../../components/Menu';
import type { LogModel } from '../../graph/logModel';
import { useHost } from '../../hostContext';
import { toggleFavorite, useFavoriteRefs } from '../../state/favorites';
import { runOperation } from '../../state/operations';
import { useQuery, useRepoVersion } from '../../state/queries';
import { addRemote, useRemotes } from '../../state/remotes';
import { useApp } from '../../state/store';
import type { TabModel } from '../../state/tabs';
import { copyWithToast, useCommitColor, useModelVersion } from './parts';
import { deleteGoneEntries, fetchRemote, removeRemote, renameRemote, showRemoteMenu } from './remoteMenu';
import { openLinkedRepository } from './submodules';
import { SubmodulesSection } from './SubmodulesSection';
import { remoteOfName } from './upstreams';
import styles from './BranchesPane.module.css';

/** Refs listed per section before "N more" (a filter finds the rest). */
const SECTION_LIMIT = 300;
const COLLAPSED_KEY = 'lanefold.branches.collapsed';

interface TreeNode {
  readonly name: string;
  readonly path: string;
  readonly children: Map<string, TreeNode>;
  ref?: RefInfo;
}

type Row =
  | {
      readonly type: 'section';
      readonly id: string;
      readonly label: string;
      readonly icon: string;
      readonly count: number;
      readonly expanded: boolean;
      readonly remote?: string;
    }
  | {
      readonly type: 'folder';
      readonly id: string;
      readonly label: string;
      readonly depth: number;
      readonly count: number;
      readonly expanded: boolean;
    }
  | {
      readonly type: 'ref';
      readonly id: string;
      readonly ref: RefInfo;
      readonly label: string;
      readonly depth: number;
    }
  | { readonly type: 'more'; readonly id: string; readonly count: number; readonly depth: number }
  /** A remote without remote branches here: never fetched. */
  | { readonly type: 'unfetched'; readonly id: string; readonly remote: string; readonly depth: number }
  /** Adds a remote; it follows the remotes' sections. */
  | { readonly type: 'addRemote'; readonly id: string; readonly depth: number };

const ADD_REMOTE_ROW: Row = { type: 'addRemote', id: 'add-remote', depth: 0 };

interface Section {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly refs: readonly RefInfo[];
  /** Name shown for a ref: without the remote prefix in a remote's section. */
  readonly labelOf: (ref: RefInfo) => string;
  /** Folders by "/" (branches); flat lists otherwise. */
  readonly folders: boolean;
  readonly remote?: string;
}

function loadCollapsed(): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? 'null') as unknown;
    if (Array.isArray(stored))
      return new Set(stored.filter((item): item is string => typeof item === 'string'));
  } catch {
    // Defaults below.
  }
  return new Set(['tags']);
}

function saveCollapsed(collapsed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Not persisted; fine.
  }
}

function buildTree(refs: readonly RefInfo[], labelOf: (ref: RefInfo) => string): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const ref of refs) {
    const parts = labelOf(ref).split('/');
    let node = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      let child = node.children.get(part);
      if (!child) node.children.set(part, (child = { name: part, path, children: new Map() }));
      node = child;
    });
    node.ref = ref;
  }
  return root;
}

function countRefs(node: TreeNode): number {
  let count = node.ref ? 1 : 0;
  for (const child of node.children.values()) count += countRefs(child);
  return count;
}

/** The rows on screen: expanded sections and folders, or flat matches while filtering. */
function visibleRows(sections: readonly Section[], collapsed: ReadonlySet<string>, filter: string): Row[] {
  const rows: Row[] = [];
  const needle = filter.trim().toLowerCase();
  // "Add remote…" comes after the remotes, before the tags (not while filtering).
  let addRemotePlaced = needle !== '';
  for (const section of sections) {
    if (!addRemotePlaced && section.id === 'tags') {
      rows.push(ADD_REMOTE_ROW);
      addRemotePlaced = true;
    }
    const refs = needle
      ? section.refs.filter((ref) => ref.short.toLowerCase().includes(needle))
      : section.refs;
    if (needle && refs.length === 0) continue;
    const expanded = needle !== '' || !collapsed.has(section.id);
    rows.push({
      type: 'section',
      id: section.id,
      label: section.label,
      icon: section.icon,
      count: refs.length,
      expanded,
      remote: section.remote,
    });
    if (!expanded) continue;
    if (section.remote !== undefined && refs.length === 0) {
      rows.push({ type: 'unfetched', id: `${section.id}:unfetched`, remote: section.remote, depth: 1 });
      continue;
    }
    let shown = 0;
    const push = (row: Row) => {
      if (row.type === 'ref') shown++;
      rows.push(row);
    };
    if (!section.folders || needle) {
      for (const ref of refs.slice(0, SECTION_LIMIT))
        push({ type: 'ref', id: `${section.id}:${ref.name}`, ref, label: section.labelOf(ref), depth: 1 });
    } else {
      const walk = (node: TreeNode, depth: number) => {
        // Folders first, then refs; each alphabetically.
        const children = [...node.children.values()].sort(
          (a, b) => Number(!a.children.size) - Number(!b.children.size) || a.name.localeCompare(b.name),
        );
        for (const child of children) {
          if (shown >= SECTION_LIMIT) return;
          if (child.ref)
            push({
              type: 'ref',
              id: `${section.id}:${child.ref.name}`,
              ref: child.ref,
              label: child.name,
              depth,
            });
          if (child.children.size > 0) {
            const id = `${section.id}/${child.path}`;
            const open = !collapsed.has(id);
            push({
              type: 'folder',
              id,
              label: child.name,
              depth,
              count: countRefs(child) - (child.ref ? 1 : 0),
              expanded: open,
            });
            if (open) walk(child, depth + 1);
          }
        }
      };
      walk(buildTree(refs, section.labelOf), 1);
    }
    if (refs.length > shown && shown >= SECTION_LIMIT)
      rows.push({ type: 'more', id: `${section.id}:more`, count: refs.length - shown, depth: 1 });
  }
  if (!addRemotePlaced) rows.push(ADD_REMOTE_ROW);
  return rows;
}

/**
 * The remote a remote branch belongs to: the longest remote name it starts with (a name may hold
 * "/"), else what precedes its first "/".
 */
function remoteOf(ref: RefInfo, remotes: readonly string[]): string {
  return remoteOfName(ref.short, remotes) ?? ref.remote ?? '';
}

function refTitle(ref: RefInfo): string {
  const parts = [ref.short];
  if (ref.upstream) {
    const sync = [ref.ahead ? `${ref.ahead} ahead` : '', ref.behind ? `${ref.behind} behind` : '']
      .filter(Boolean)
      .join(', ');
    parts.push(ref.gone ? `${ref.upstream} is gone` : `tracks ${ref.upstream}${sync ? ` (${sync})` : ''}`);
  }
  if (ref.date) parts.push(`last commit ${relativeLong(ref.date)}`);
  return parts.join(' · ');
}

function RefRow({
  row,
  model,
  focused,
  current,
  selected,
  hidden,
  favorite,
  canHide,
  elsewhere,
  onClick,
  onMenu,
  onToggleHidden,
  onToggleFavorite,
}: {
  row: Extract<Row, { type: 'ref' }>;
  model: LogModel | undefined;
  focused: boolean;
  current: boolean;
  selected: boolean;
  hidden: boolean;
  favorite: boolean;
  canHide: boolean;
  /** Checked out in another worktree (its folder). */
  elsewhere?: string;
  onClick: () => void;
  onMenu: (event: MouseEvent<HTMLElement>) => void;
  onToggleHidden: () => void;
  onToggleFavorite: () => void;
}) {
  const { ref } = row;
  const color = useCommitColor(model, ref.target);
  const icon =
    ref.kind === 'tag' ? 'tag' : ref.kind === 'remote' ? 'cloud' : current ? 'check' : 'git-branch';
  return (
    <div
      id={`branch-row-${row.id}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-current={current || undefined}
      className={styles.row}
      data-focused={focused}
      data-hidden={hidden}
      data-current={current}
      style={{ paddingLeft: 6 + row.depth * 12 }}
      title={refTitle(ref)}
      onClick={onClick}
      onDoubleClick={() => {
        if (ref.isHead) return;
        void runOperation(
          ref.kind === 'tag'
            ? { kind: 'checkout', target: ref.short, detach: true }
            : { kind: 'checkout', target: ref.short },
        );
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event);
      }}
    >
      <Icon name={icon} className={styles.refIcon} style={color && !hidden ? { color } : undefined} />
      <span className={styles.name}>{row.label}</span>
      {elsewhere ? (
        <Icon name="multiple-windows" className={styles.elsewhere} title={`Checked out in ${elsewhere}`} />
      ) : null}
      {ref.gone ? <Icon name="warning" className={styles.gone} title={`${ref.upstream} is gone`} /> : null}
      {ref.ahead ? (
        <span className={styles.ahead} title={`${ref.ahead} commit${ref.ahead === 1 ? '' : 's'} to push`}>
          ↑{ref.ahead}
        </span>
      ) : null}
      {ref.behind ? (
        <span className={styles.behind} title={`${ref.behind} commit${ref.behind === 1 ? '' : 's'} to pull`}>
          ↓{ref.behind}
        </span>
      ) : null}
      <span className={styles.rowActions}>
        <button
          type="button"
          className={styles.rowAction}
          data-on={favorite}
          tabIndex={-1}
          aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
          title={favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite();
          }}
        >
          <Icon name={favorite ? 'star-full' : 'star-empty'} />
        </button>
        {canHide ? (
          <button
            type="button"
            className={styles.rowAction}
            data-on={hidden}
            tabIndex={-1}
            aria-label={hidden ? 'Show in this view' : 'Hide in this view'}
            title={hidden ? 'Show in this view' : 'Hide in this view (its own commits too)'}
            onClick={(event) => {
              event.stopPropagation();
              onToggleHidden();
            }}
          >
            <Icon name={hidden ? 'eye-closed' : 'eye'} />
          </button>
        ) : null}
      </span>
    </div>
  );
}

export interface BranchesPaneProps {
  readonly repoId: string;
  readonly tab: TabModel;
  readonly model: LogModel | undefined;
  /** Commits selected in the graph (their refs are marked). */
  readonly selection: readonly string[];
  readonly onReveal: (ref: RefInfo) => void;
  /** Opens a ref's menu, with entries for this pane. */
  readonly onMenu: (
    ref: RefInfo,
    event: { currentTarget: EventTarget | null; clientX: number; clientY: number },
    extra: readonly MenuEntry[],
  ) => void;
}

/** Branches, remote branches and tags of the repository, beside the graph. */
function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '');
}

function worktreeMenu(repoId: string, tree: WorktreeInfo, x: number, y: number, open: () => void): void {
  openMenu({ x, y }, [
    { kind: 'title', label: tree.branch ? `Worktree of ${tree.branch}` : 'Worktree' },
    {
      id: 'open',
      label: 'Open in New Window',
      icon: 'multiple-windows',
      disabled: tree.current,
      reason: 'It is the worktree open here',
      onSelect: open,
    },
    {
      id: 'lanefold',
      label: 'Open in Lanefold',
      icon: 'repo',
      hint: 'Switch to it here',
      disabled: tree.current || !!tree.prunable,
      reason: tree.current ? 'It is the worktree open here' : 'Its folder is gone',
      onSelect: () => void openLinkedRepository(repoId, tree.path),
    },
    { id: 'copy', label: 'Copy path', icon: 'copy', onSelect: () => void copyWithToast(tree.path, 'path') },
    { kind: 'separator' },
    tree.prunable
      ? {
          id: 'prune',
          label: 'Forget worktrees whose folder is gone',
          icon: 'trash',
          hint: 'git worktree prune',
          onSelect: () => void runOperation({ kind: 'pruneWorktrees' }),
        }
      : {
          id: 'remove',
          label: 'Remove worktree…',
          icon: 'trash',
          hint: `git worktree remove ${tree.path}`,
          danger: true,
          disabled: tree.main || tree.current,
          reason: tree.main
            ? 'The main worktree holds the repository: it stays'
            : 'It is the worktree open here',
          onSelect: () => void runOperation({ kind: 'removeWorktree', path: tree.path }),
        },
  ]);
}

export function BranchesPane({ repoId, tab, model, selection, onReveal, onMenu }: BranchesPaneProps) {
  useModelVersion(model);
  const host = useHost();
  const version = useRepoVersion(host.rpc, repoId);
  const worktrees = useQuery(`${repoId}:worktrees:${version}`, () =>
    host.rpc.call('worktree.list', { repoId }),
  ).data;
  const openFolder = (path: string) =>
    void host.rpc.call('host.command', { command: 'openFolder', args: { path } }).catch(() => undefined);
  const configuredRemotes = useRemotes(repoId);
  const view = tab.view!;
  const refs = useMemo(() => model?.refs.refs ?? [], [model?.refs]);
  const head = model?.refs.head;
  const favorites = useFavoriteRefs(repoId);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [filter, setFilter] = useState('');
  const [focus, setFocus] = useState<string>();
  const treeRef = useRef<HTMLDivElement>(null);

  const hidden = useMemo(() => new Set(view.hidden), [view.hidden]);
  const scopeAllowsHiding = view.scope.type === 'all' || view.scope.type === 'local';
  const selected = useMemo(() => new Set(selection), [selection]);

  const sections = useMemo<Section[]>(() => {
    const byName = (a: RefInfo, b: RefInfo) => a.short.localeCompare(b.short);
    const favoriteSet = new Set(favorites);
    const list: Section[] = [];
    const favs = refs.filter((ref) => favoriteSet.has(ref.name)).sort(byName);
    if (favs.length > 0)
      list.push({
        id: 'favorites',
        label: 'Favorites',
        icon: 'star-full',
        refs: favs,
        labelOf: (r) => r.short,
        folders: false,
      });
    list.push({
      id: 'local',
      label: 'Branches',
      icon: 'git-branch',
      refs: refs.filter((ref) => ref.kind === 'branch').sort(byName),
      labelOf: (r) => r.short,
      folders: true,
    });
    // One section per remote, fetched or not, and per remote whose branches outlived it.
    const configured = (configuredRemotes ?? []).map((remote) => remote.name);
    const owner = (ref: RefInfo) => remoteOf(ref, configured);
    const remoteRefs = refs.filter((ref) => ref.kind === 'remote' && !ref.short.endsWith('/HEAD'));
    const remotes = [...new Set([...configured, ...remoteRefs.map(owner)])].sort();
    for (const remote of remotes) {
      const prefix = `${remote}/`;
      list.push({
        // ":" ends the name (no ref name holds one): remote "team"'s folder "ci" is not remote "team/ci".
        id: `remote:${remote}:`,
        label: remote || 'Remote',
        icon: 'cloud',
        refs: remoteRefs.filter((ref) => owner(ref) === remote).sort(byName),
        labelOf: (r) => (r.short.startsWith(prefix) ? r.short.slice(prefix.length) : r.short),
        folders: true,
        remote,
      });
    }
    const tags = refs.filter((ref) => ref.kind === 'tag');
    if (tags.length > 0)
      list.push({
        id: 'tags',
        label: 'Tags',
        icon: 'tag',
        // Newest first: the latest releases are the interesting ones.
        refs: tags.sort((a, b) => (b.date ?? 0) - (a.date ?? 0) || b.short.localeCompare(a.short)),
        labelOf: (r) => r.short,
        folders: false,
      });
    return list;
  }, [refs, favorites, configuredRemotes]);

  const rows = useMemo(() => visibleRows(sections, collapsed, filter), [sections, collapsed, filter]);
  const checkedOutElsewhere = useMemo(
    () =>
      new Map(
        (worktrees ?? []).flatMap((tree) =>
          tree.branch && !tree.current ? [[tree.branch, tree.path] as const] : [],
        ),
      ),
    [worktrees],
  );
  const remoteNames = useMemo(
    () =>
      [...new Set(refs.flatMap((ref) => (ref.kind === 'remote' && ref.remote ? [ref.remote] : [])))].sort(),
    [refs],
  );
  const focusIndex = Math.max(
    0,
    rows.findIndex((row) => row.id === focus),
  );
  // Until the remotes are known, every remote section counts as configured.
  const isConfigured = (remote: string) =>
    !configuredRemotes || configuredRemotes.some((candidate) => candidate.name === remote);
  const remoteTitle = (remote: string) => {
    if (!configuredRemotes) return undefined;
    const info = configuredRemotes.find((candidate) => candidate.name === remote);
    if (!info)
      return `${remote}: its remote branches remain, but it is no longer a remote of this repository`;
    return [remote, info.url ?? 'no URL', info.pushUrl ? `pushes to ${info.pushUrl}` : '']
      .filter(Boolean)
      .join(' · ');
  };
  const remoteMenu = (remote: string, anchor: Element | { x: number; y: number }) =>
    showRemoteMenu(anchor, remote, configuredRemotes ?? [], refs);
  /** The Branches section's: a new branch, and deleting the branches whose upstream is gone. */
  const branchesMenu = (anchor: Element | { x: number; y: number }) =>
    openMenu(anchor, [
      { kind: 'title', label: 'Branches' },
      {
        id: 'new-branch',
        label: 'New branch…',
        icon: 'git-branch-create',
        hint: 'git switch -c <name>',
        disabled: !head || head.unborn,
        reason: 'There is no commit to start it at yet',
        onSelect: () => void runOperation({ kind: 'createBranch', name: '', at: 'HEAD', checkout: true }),
      },
      ...deleteGoneEntries(
        refs,
        (configuredRemotes ?? []).map((remote) => remote.name),
      ),
    ]);

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    saveCollapsed(next);
  };

  const toggleHidden = (ref: RefInfo) => {
    const next = new Set(hidden);
    if (next.has(ref.name)) next.delete(ref.name);
    else next.add(ref.name);
    useApp.getState().updateTab(tab.id, { view: { ...view, hidden: [...next].sort() } });
  };

  const canHide = (ref: RefInfo) =>
    scopeAllowsHiding &&
    isHideableRef(ref.name) &&
    !ref.isHead &&
    (view.scope.type === 'all' || ref.kind === 'branch');

  const extraEntries = (ref: RefInfo): MenuEntry[] => {
    const entries: MenuEntry[] = [
      {
        id: 'favorite',
        label: favorites.includes(ref.name) ? 'Remove from favorites' : 'Add to favorites',
        icon: favorites.includes(ref.name) ? 'star-empty' : 'star-full',
        onSelect: () => toggleFavorite(repoId, ref.name),
      },
    ];
    if (canHide(ref))
      entries.push({
        id: 'hide',
        label: hidden.has(ref.name) ? 'Show in this view' : 'Hide in this view',
        icon: hidden.has(ref.name) ? 'eye' : 'eye-closed',
        onSelect: () => toggleHidden(ref),
      });
    return entries;
  };

  const rowElement = (row: Row) => document.getElementById(`branch-row-${row.id}`);

  const moveFocus = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    if (!row) return;
    setFocus(row.id);
    rowElement(row)?.scrollIntoView({ block: 'nearest' });
  };

  const onTreeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[focusIndex];
    if (!row) return;
    const expandable = row.type === 'section' || row.type === 'folder';
    if (event.key === 'ArrowDown') moveFocus(focusIndex + 1);
    else if (event.key === 'ArrowUp') moveFocus(focusIndex - 1);
    else if (event.key === 'Home') moveFocus(0);
    else if (event.key === 'End') moveFocus(rows.length - 1);
    else if (event.key === 'PageDown') moveFocus(focusIndex + 10);
    else if (event.key === 'PageUp') moveFocus(focusIndex - 10);
    else if (event.key === 'ArrowRight') {
      if (expandable && !row.expanded) toggle(row.id);
      else moveFocus(focusIndex + 1);
    } else if (event.key === 'ArrowLeft') {
      if (expandable && row.expanded) toggle(row.id);
      else {
        // To the enclosing folder or section.
        const depth = row.type === 'section' ? 0 : row.depth;
        for (let i = focusIndex - 1; i >= 0; i--) {
          const above = rows[i]!;
          const aboveDepth = above.type === 'section' ? 0 : above.depth;
          if ((above.type === 'section' || above.type === 'folder') && aboveDepth < depth) {
            moveFocus(i);
            break;
          }
        }
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (row.type === 'ref') onReveal(row.ref);
      else if (row.type === 'unfetched') fetchRemote(row.remote);
      else if (row.type === 'addRemote') addRemote(configuredRemotes);
      else if (expandable) toggle(row.id);
    } else if (
      row.type === 'ref' &&
      (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))
    ) {
      const element = rowElement(row);
      const rect = element?.getBoundingClientRect();
      onMenu(
        row.ref,
        { currentTarget: element, clientX: rect?.left ?? 0, clientY: rect?.bottom ?? 0 },
        extraEntries(row.ref),
      );
    } else if (row.type === 'ref' && event.key === 'F2' && row.ref.kind === 'branch') {
      void runOperation({ kind: 'renameBranch', from: row.ref.short, to: row.ref.short });
    } else if (row.type === 'ref' && event.key === 'Delete' && !row.ref.isHead) {
      void runOperation(
        row.ref.kind === 'tag'
          ? { kind: 'deleteTag', name: row.ref.short }
          : row.ref.kind === 'remote'
            ? { kind: 'deleteRemoteBranch', name: row.ref.short }
            : { kind: 'deleteBranch', name: row.ref.short },
        // From a remote, always reviewed: Undo cannot bring it back.
        { review: row.ref.kind === 'remote' },
      );
    } else if (
      row.type === 'section' &&
      (row.remote !== undefined || row.id === 'local') &&
      (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))
    ) {
      // From the keyboard, at the row (its first entry active).
      const anchor = rowElement(row) ?? { x: 0, y: 0 };
      if (row.remote !== undefined) remoteMenu(row.remote, anchor);
      else branchesMenu(anchor);
    } else if (
      row.type === 'section' &&
      row.remote !== undefined &&
      isConfigured(row.remote) &&
      (event.key === 'F2' || event.key === 'Delete')
    ) {
      if (event.key === 'F2') renameRemote(row.remote);
      else removeRemote(row.remote);
    } else return;
    event.preventDefault();
  };

  const focused = rows[focusIndex];
  return (
    <div className={styles.root}>
      <div className={styles.search}>
        <Icon name="filter" className={styles.searchIcon} />
        <input
          className={styles.searchInput}
          value={filter}
          placeholder="Filter branches and tags"
          aria-label="Filter branches and tags"
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            // Keys that drive an input method's composition are not commands.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Escape' && filter) {
              event.preventDefault();
              event.stopPropagation();
              setFilter('');
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              treeRef.current?.focus();
              const first = rows.find((row) => row.type === 'ref');
              if (first) setFocus(first.id);
            } else if (event.key === 'Enter') {
              const first = rows.find((row) => row.type === 'ref');
              if (first?.type === 'ref') onReveal(first.ref);
            }
          }}
        />
      </div>
      <div
        ref={treeRef}
        className={styles.tree}
        role="tree"
        aria-label="Branches, remotes and tags"
        tabIndex={0}
        aria-activedescendant={focused ? `branch-row-${focused.id}` : undefined}
        onKeyDown={onTreeKey}
      >
        {rows.length === 0 ? <div className={styles.empty}>No branches or tags match “{filter}”.</div> : null}
        {rows.map((row, index) => {
          if (row.type === 'ref') {
            return (
              <RefRow
                key={row.id}
                row={row}
                model={model}
                focused={index === focusIndex && focus !== undefined}
                current={!!row.ref.isHead && row.ref.short === head?.branch}
                selected={selected.has(row.ref.target)}
                hidden={hidden.has(row.ref.name)}
                favorite={favorites.includes(row.ref.name)}
                canHide={canHide(row.ref)}
                elsewhere={row.ref.kind === 'branch' ? checkedOutElsewhere.get(row.ref.short) : undefined}
                onClick={() => {
                  setFocus(row.id);
                  onReveal(row.ref);
                }}
                onMenu={(event) => {
                  setFocus(row.id);
                  onMenu(row.ref, event, extraEntries(row.ref));
                }}
                onToggleHidden={() => toggleHidden(row.ref)}
                onToggleFavorite={() => toggleFavorite(repoId, row.ref.name)}
              />
            );
          }
          if (row.type === 'more') {
            return (
              <div key={row.id} className={styles.more} style={{ paddingLeft: 6 + row.depth * 12 }}>
                {row.count.toLocaleString()} more — filter to find them
              </div>
            );
          }
          if (row.type === 'unfetched') {
            return (
              <div
                key={row.id}
                id={`branch-row-${row.id}`}
                role="treeitem"
                aria-level={row.depth + 1}
                className={styles.unfetched}
                data-focused={index === focusIndex && focus !== undefined}
                style={{ paddingLeft: 6 + row.depth * 12 }}
                onClick={() => setFocus(row.id)}
              >
                <span className={styles.unfetchedText}>No branches fetched yet</span>
                <button
                  type="button"
                  className={styles.inlineAction}
                  tabIndex={-1}
                  title={`Download the branches of ${row.remote}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setFocus(row.id);
                    fetchRemote(row.remote);
                  }}
                >
                  Fetch
                </button>
              </div>
            );
          }
          if (row.type === 'addRemote') {
            return (
              <div
                key={row.id}
                id={`branch-row-${row.id}`}
                role="treeitem"
                aria-level={1}
                className={styles.addRemote}
                data-focused={index === focusIndex && focus !== undefined}
                title="Add a remote: a repository to fetch from and push to"
                onClick={() => {
                  setFocus(row.id);
                  addRemote(configuredRemotes);
                }}
              >
                <Icon name="add" className={styles.chevron} />
                <span className={styles.name}>Add remote…</span>
              </div>
            );
          }
          const isSection = row.type === 'section';
          const remote = row.type === 'section' ? row.remote : undefined;
          return (
            <div
              key={row.id}
              id={`branch-row-${row.id}`}
              role="treeitem"
              aria-level={isSection ? 1 : row.depth + 1}
              aria-expanded={row.expanded}
              className={isSection ? styles.section : styles.folder}
              data-focused={index === focusIndex && focus !== undefined}
              style={isSection ? undefined : { paddingLeft: 6 + row.depth * 12 }}
              title={remote !== undefined ? remoteTitle(remote) : undefined}
              onClick={() => {
                setFocus(row.id);
                toggle(row.id);
              }}
              onContextMenu={
                remote !== undefined || row.id === 'local'
                  ? (event) => {
                      event.preventDefault();
                      setFocus(row.id);
                      const at = { x: event.clientX, y: event.clientY };
                      if (remote !== undefined) remoteMenu(remote, at);
                      else branchesMenu(at);
                    }
                  : undefined
              }
            >
              <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} className={styles.chevron} />
              {isSection ? null : (
                <Icon name={row.expanded ? 'folder-opened' : 'folder'} className={styles.folderIcon} />
              )}
              <span className={styles.name}>{row.label}</span>
              <span className={styles.count}>{row.count}</span>
              {isSection && row.id === 'local' && head && !head.unborn ? (
                <button
                  type="button"
                  className={styles.sectionAction}
                  tabIndex={-1}
                  title="New branch at HEAD"
                  aria-label="New branch"
                  onClick={(event) => {
                    event.stopPropagation();
                    void runOperation({ kind: 'createBranch', name: '', at: 'HEAD', checkout: true });
                  }}
                >
                  <Icon name="add" />
                </button>
              ) : null}
              {isSection && row.type === 'section' && row.remote !== undefined && isConfigured(row.remote) ? (
                <button
                  type="button"
                  className={styles.sectionAction}
                  tabIndex={-1}
                  title={`Fetch ${row.remote}`}
                  aria-label={`Fetch ${row.remote}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void runOperation({ kind: 'fetch', remote: row.remote });
                  }}
                >
                  <Icon name="repo-fetch" />
                </button>
              ) : null}
              {isSection && row.id === 'tags' && remoteNames.length > 0 ? (
                <button
                  type="button"
                  className={styles.sectionAction}
                  tabIndex={-1}
                  title={`Push all tags to ${remoteNames.includes('origin') ? 'origin' : remoteNames[0]}`}
                  aria-label="Push all tags"
                  onClick={(event) => {
                    event.stopPropagation();
                    void runOperation(
                      { kind: 'pushTag', remote: remoteNames.includes('origin') ? 'origin' : remoteNames[0] },
                      { review: true },
                    );
                  }}
                >
                  <Icon name="cloud-upload" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {worktrees && (worktrees.length > 1 || worktrees.some((tree) => tree.prunable)) ? (
        <div className={styles.worktrees} role="group" aria-label="Worktrees">
          <div
            className={styles.section}
            aria-expanded={!collapsed.has('worktrees')}
            onClick={() => toggle('worktrees')}
          >
            <Icon
              name={collapsed.has('worktrees') ? 'chevron-right' : 'chevron-down'}
              className={styles.chevron}
            />
            <span className={styles.name}>Worktrees</span>
            <span className={styles.count}>{worktrees.length}</span>
          </div>
          {collapsed.has('worktrees')
            ? null
            : worktrees.map((tree) => (
                <div
                  key={tree.path}
                  className={styles.row}
                  data-current={tree.current}
                  style={{ paddingLeft: 18 }}
                  title={[tree.path, tree.prunable, tree.locked && `locked: ${tree.locked}`]
                    .filter(Boolean)
                    .join(' · ')}
                  onDoubleClick={() => !tree.current && openFolder(tree.path)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    worktreeMenu(repoId, tree, event.clientX, event.clientY, () => openFolder(tree.path));
                  }}
                >
                  <Icon name={tree.main ? 'root-folder' : 'folder'} className={styles.refIcon} />
                  <span className={styles.name}>
                    {folderName(tree.path)}
                    {tree.branch ? <span className={styles.worktreeBranch}> {tree.branch}</span> : null}
                  </span>
                  {tree.prunable ? (
                    <Icon name="warning" className={styles.gone} title={tree.prunable} />
                  ) : null}
                  {tree.locked ? <Icon name="lock" className={styles.elsewhere} title={tree.locked} /> : null}
                </div>
              ))}
        </div>
      ) : null}
      <SubmodulesSection
        repoId={repoId}
        collapsed={collapsed.has('submodules')}
        onToggle={() => toggle('submodules')}
      />
    </div>
  );
}
