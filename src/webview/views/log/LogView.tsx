import { AnimatePresence } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Splitter, usePersistentSize } from '../../components/Splitter';
import { toast } from '../../components/Toast';
import { isWorkingTreeSha } from '../../graph/format';
import { GraphPane } from '../../graph/GraphPane';
import type { EmptyNote, GraphView, Highlight } from '../../graph/GraphView';
import { useHost } from '../../hostContext';
import { useOperations } from '../../state/operations';
import { operationMarks } from './marks';
import { takeReveal, useReveal } from '../../state/reveal';
import { startRewrite, useRewrite } from '../../state/rewrite';
import type { TabModel } from '../../state/tabs';
import { useApp } from '../../state/store';
import { usePalette } from '../../state/theme';
import { editableHistory } from '../rewrite/entryPoints';
import { HistoryEditor } from '../rewrite/HistoryEditor';
import { BranchesPane } from './BranchesPane';
import { DetailsPane } from './DetailsPane';
import { HoverCard, type HoverTarget } from './HoverCard';
import { LogToolbar } from './LogToolbar';
import {
  openCommitChanges,
  openCompareTab,
  openHistoryTab,
  openWorkingTreeChanges,
  showDropMenu,
  showRefMenu,
  showRowMenu,
  type MenuContext,
} from './logMenus';
import { copyWithToast, useCommitColor } from './parts';
import { editBlocker } from './reach';
import { useLogModel } from './useLogModel';
import { useFilteredModel, useLogSearch, type SearchMatches } from './useLogSearch';
import styles from './LogView.module.css';

/** Width below which the details pane moves under the graph (or list, in other views). */
export const STACK_BELOW = 700;
/** Width below which the branches pane is left out. */
const BRANCHES_BELOW = 900;
/**
 * The graph keeps at least this much room: the branches pane steps aside first. Where it fits
 * only without the details pane, the two take turns.
 */
const GRAPH_MIN = 440;

export function usePersistentFlag(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(`lanefold.flag.${key}`);
      return stored === null ? initial : stored === '1';
    } catch {
      return initial;
    }
  });
  return [
    value,
    (next) => {
      setValue(next);
      try {
        localStorage.setItem(`lanefold.flag.${key}`, next ? '1' : '0');
      } catch {
        // Not persisted; fine.
      }
    },
  ];
}

/** The element's width; a hidden tab (width 0) keeps its last one, so its panes stay as they were. */
export function useWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry!.contentRect.width > 0) setWidth(entry!.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * The same for an element that may mount after the first render (a view that shows a loading
 * line first): pass the returned callback as its `ref`.
 */
export function useElementWidth<T extends HTMLElement>(): [(element: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry!.contentRect.width > 0) setWidth(entry!.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}

export interface LogViewProps {
  readonly tab: TabModel;
  readonly repoId: string;
  /** The tab is in front (hidden tabs stay mounted but defer reloads). */
  readonly active: boolean;
}

/** A log tab: toolbar with search, the commit graph and the details pane. */
export function LogView({ tab, repoId, active }: LogViewProps) {
  const host = useHost();
  const view = tab.view!;
  const graphRef = useRef<GraphView | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loaded = useLogModel(repoId, view, active, () => graphRef.current?.topRow ?? 0);
  const source = loaded?.model;
  const search = useLogSearch(repoId, view, source, undefined, tab.search);
  // A tab opened on a search (an author's commits) keeps it, as it changes, until it is cleared.
  useEffect(() => {
    if (tab.search === undefined || search.query === tab.search) return;
    useApp.getState().updateTab(tab.id, { search: search.query || undefined });
  }, [search.query, tab.search, tab.id]);
  const [filterMode, setFilterMode] = usePersistentFlag('searchFilter', false);
  const filtered = useFilteredModel(source, search.matches, filterMode);
  const model = filtered ?? source;

  const [selection, setSelection] = useState<readonly string[]>([]);
  const [hover, setHover] = useState<HoverTarget>();
  const [pinned, setPinned] = useState<{ shas: readonly string[]; label: string }>();
  const [cursor, setCursor] = useState<{ matches?: SearchMatches; index: number }>({ index: -1 });
  const matchIndex = cursor.matches === search.matches ? cursor.index : -1;

  const [detailsOpen, setDetailsOpen] = usePersistentFlag('details', true);
  const [detailsWidth, setDetailsWidth] = usePersistentSize('details.width', 380);
  const [detailsHeight, setDetailsHeight] = usePersistentSize('details.height', 240);
  const width = useWidth(rootRef);
  const stacked = width > 0 && width < STACK_BELOW;
  const [branchesOpen, setBranchesOpen] = usePersistentFlag('branches', true);
  const [branchesWidth, setBranchesWidth] = usePersistentSize('branches.width', 230);
  const besideDetails = detailsOpen && !stacked ? detailsWidth : 0;
  const branchesRoom = width >= BRANCHES_BELOW && width - branchesWidth >= GRAPH_MIN;
  const branchesFit = branchesRoom && width - besideDetails - branchesWidth >= GRAPH_MIN;
  const toggleBranches = () => {
    if (branchesOpen && branchesFit) {
      setBranchesOpen(false);
      return;
    }
    if (!branchesFit) setDetailsOpen(false);
    setBranchesOpen(true);
  };

  // While bisecting, the commits still suspected stand out (then the one found).
  const bisect = useOperations((state) =>
    state.opState?.kind === 'bisect' ? state.opState.bisect : undefined,
  );
  // What an operation in progress is doing to which commits, as chips on their rows.
  const opState = useOperations((state) => state.opState);
  const marks = useMemo(() => operationMarks(opState), [opState]);
  const highlight = useMemo<Highlight | undefined>(() => {
    if (pinned) return { shas: new Set(pinned.shas), mode: 'highlight' };
    if (search.matches && !filterMode) return { shas: search.matches.shas, mode: 'highlight' };
    if (bisect?.firstBad) return { shas: new Set([bisect.firstBad]), mode: 'highlight' };
    if (bisect && bisect.suspects.length > 0) return { shas: new Set(bisect.suspects), mode: 'highlight' };
    return undefined;
  }, [pinned, search.matches, filterMode, bisect]);

  // Filtering, every row is a match: all of them count (not only those laid out so far).
  const matchCount = filterMode ? (filtered?.topology.rowCount ?? 0) : (search.matches?.shas.size ?? 0);
  // Stacked under the graph with nothing selected, the details pane shrinks to a line.
  const detailsCollapsed = stacked && selection.length === 0;

  // History edit mode: the editor covers this tab while a session belongs to it.
  const rewrite = useRewrite((state) =>
    state.session?.tabId === tab.id && state.session.repoId === repoId ? state.session : undefined,
  );
  const palette = usePalette();
  const branchColor = useCommitColor(source, source?.refs.head.sha ?? '') ?? palette.css[0]!;

  // A single match is where the user wants to go (e.g. a pasted hash): select it. Only for a new
  // query: refreshed results (the history reloaded) leave the view where the person is.
  const jumpedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!search.query) jumpedFor.current = undefined;
    const graph = graphRef.current;
    if (!graph || !search.matches || !model) return;
    const key = `${search.query}\0${filterMode}`;
    if (jumpedFor.current === key) return;
    const rows = filterMode ? [0] : graph.highlightedRows;
    if (rows.length === 0) return;
    jumpedFor.current = key;
    if (search.matches.shas.size === 1 && rows.length === 1) graph.selectRow(rows[0]!);
    else graph.showRow(rows[0]!);
  }, [search.matches, search.query, model, filterMode]);

  // A repository without commits yet: its uncommitted changes are all there is to look at, so
  // they are selected (once: clearing the selection keeps it clear).
  const autoSelected = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!model) return;
    const select = () => {
      const graph = graphRef.current;
      if (autoSelected.current === repoId || !graph || graph.selection.length > 0) return;
      // Once loaded: a row still streaming in cannot be laid out, so not selected yet either.
      if (!model.refs.head.unborn || !model.hasWorkingTreeRow || model.phase !== 'ready') return;
      graph.selectRow(0, 'nearest');
      if (graph.selection.length > 0) autoSelected.current = repoId;
    };
    select();
    return model.subscribe(select);
  }, [model, repoId]);

  const context = (): MenuContext | undefined =>
    graphRef.current && model ? { rpc: host.rpc, repoId, model, graph: graphRef.current } : undefined;

  const stepMatch = (delta: number) => {
    const graph = graphRef.current;
    if (!graph || !model || (filterMode && !filtered)) return;
    const rows = filterMode
      ? Array.from({ length: model.topology.rowCount }, (_, i) => i)
      : graph.highlightedRows;
    if (rows.length === 0) return;
    const next =
      matchIndex < 0 ? (delta > 0 ? 0 : rows.length - 1) : (matchIndex + delta + rows.length) % rows.length;
    setCursor({ matches: search.matches, index: next });
    graph.selectRow(rows[next]!);
  };

  const clearSearch = () => {
    search.setText('');
    graphRef.current?.focus();
  };

  // Filtering down to nothing: say so, and offer the ways back.
  const emptyNote: EmptyNote | undefined =
    filterMode && search.query
      ? {
          title: `No commits match ‘${search.query}’`,
          detail: 'Nothing this view shows matches the search.',
          actions: [
            { label: 'Clear search', run: clearSearch },
            { label: 'Switch to Highlight', run: () => setFilterMode(false) },
          ],
        }
      : undefined;

  // Ctrl/Cmd+F and "/" focus the search box; Ctrl/Cmd+C copies the selected hashes.
  useEffect(() => {
    if (!active || rewrite) return;
    const onKeyDown = (event: KeyboardEvent) => {
      setHover(undefined);
      const mod = event.ctrlKey || event.metaKey;
      const inInput = (event.target as HTMLElement | null)?.closest('input, textarea');
      if ((mod && event.key.toLowerCase() === 'f') || (event.key === '/' && !inInput && !mod)) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (event.key === 'F3') {
        event.preventDefault();
        stepMatch(event.shiftKey ? -1 : 1);
      } else if (event.key === 'F2' && !inInput && graphRef.current?.root.contains(document.activeElement)) {
        // Reword the selected commit (in the history editor, message ready to type).
        const shas = graphRef.current.selection;
        const sha = shas.length === 1 ? shas[0]! : undefined;
        const editable = model ? editableHistory(model) : undefined;
        if (sha && model && editable?.has(sha)) {
          event.preventDefault();
          const parent = model.metaOf(sha)?.parents[0] ?? null;
          void startRewrite({
            base: parent,
            arrange: (entries) =>
              entries.map((entry) => (entry.sha === sha ? { sha, action: 'reword' } : entry)),
            select: [sha],
            editMessage: sha,
          });
        } else if (sha && model && editable && !isWorkingTreeSha(sha)) {
          // Out of the history editor's reach: say why rather than nothing.
          event.preventDefault();
          const reason = editBlocker(model, sha, editable);
          if (reason) toast(reason);
        }
      } else if (mod && event.key.toLowerCase() === 'c' && !inInput && !window.getSelection()?.toString()) {
        const graph = graphRef.current;
        const shas = graph?.selection.filter((sha) => !isWorkingTreeSha(sha)) ?? [];
        if (shas.length > 0 && graph?.root.contains(document.activeElement)) {
          event.preventDefault();
          void copyWithToast(shas.join('\n'), shas.length > 1 ? 'hashes' : 'hash');
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // A commit the host asked to show (from a blame hover or the status bar).
  const revealRequest = useReveal((state) =>
    active && state.request?.repoId === repoId ? state.request : undefined,
  );
  useEffect(() => {
    const reveal = revealRequest;
    if (!reveal || !model) return;
    const attempt = () => {
      const graph = graphRef.current;
      if (graph?.goTo(reveal.sha)) {
        takeReveal(reveal.id);
        graph.focus();
        return true;
      }
      if (model.phase === 'ready' || model.phase === 'error') {
        // Uncommitted changes appear once the view reloads after the operation that made them
        // (splitting a commit): watch for them a little while, without a word.
        if (isWorkingTreeSha(reveal.sha)) {
          if (Date.now() - reveal.time < 5000) return false;
          takeReveal(reveal.id);
          return true;
        }
        takeReveal(reveal.id);
        toast('That commit is not in this view', {
          detail: reveal.sha.slice(0, 12),
          action: {
            label: 'Show its history',
            run: () => openHistoryTab(reveal.sha, reveal.sha.slice(0, 8)),
          },
        });
        return true;
      }
      return false;
    };
    if (attempt()) return;
    // Still streaming: try again as rows arrive.
    return model.subscribe(() => void attempt());
  }, [revealRequest, model]);

  const onOpen = (row: number) => {
    const ctx = context();
    if (!ctx) return;
    const sha = ctx.model.sha(row);
    if (isWorkingTreeSha(sha)) void openWorkingTreeChanges(ctx);
    else void openCommitChanges(ctx, sha);
  };

  const reveal = (sha: string) => {
    if (!graphRef.current?.goTo(sha)) toast('That commit is not in this view', { detail: sha.slice(0, 12) });
  };

  const details =
    detailsOpen && model ? (
      <aside
        className={styles.details}
        style={detailsCollapsed ? undefined : stacked ? { height: detailsHeight } : { width: detailsWidth }}
        aria-label="Commit details"
      >
        <DetailsPane
          repoId={repoId}
          model={model}
          selection={selection}
          compact={detailsCollapsed}
          onReveal={reveal}
          onHighlight={(shas) =>
            setPinned(
              shas
                ? {
                    shas,
                    label: `Highlighting ${shas.length.toLocaleString()} commit${shas.length === 1 ? '' : 's'}`,
                  }
                : undefined,
            )
          }
          onOpenCompare={(a, b) => openCompareTab(a, b, 'two-dot')}
        />
      </aside>
    ) : null;

  return (
    <div ref={rootRef} className={styles.root}>
      <LogToolbar
        tab={tab}
        source={source}
        filtered={filtered}
        search={{
          inputRef: searchRef,
          text: search.text,
          onText: search.setText,
          pending: search.pending,
          error: search.error,
          matches: search.matches,
          matchCount,
          matchIndex,
          onStep: stepMatch,
          onEscape: clearSearch,
        }}
        filterMode={filterMode}
        onFilterMode={setFilterMode}
        pinned={pinned ? { label: pinned.label, onClear: () => setPinned(undefined) } : undefined}
        detailsOpen={detailsOpen}
        onToggleDetails={() => setDetailsOpen(!detailsOpen)}
        branchesOpen={branchesRoom ? branchesOpen && branchesFit : undefined}
        onToggleBranches={toggleBranches}
      />
      <div className={styles.body} data-stacked={stacked}>
        {branchesFit && branchesOpen && !stacked ? (
          <>
            <aside className={styles.branches} style={{ width: branchesWidth }} aria-label="Branches">
              <BranchesPane
                repoId={repoId}
                tab={tab}
                model={source}
                selection={selection}
                onReveal={(ref) => {
                  if (!graphRef.current?.goTo(ref.target))
                    toast(`${ref.short} is not in this view`, {
                      detail: (tab.view?.hidden ?? []).includes(ref.name)
                        ? 'It is hidden here.'
                        : 'Its commits are not part of what this view shows.',
                      action: { label: 'Show its history', run: () => openHistoryTab(ref.short) },
                    });
                }}
                onMenu={(ref, event, extra) => {
                  setHover(undefined);
                  const ctx = context();
                  if (ctx) showRefMenu(ctx, ref, event, extra);
                }}
              />
            </aside>
            <Splitter
              orientation="vertical"
              before
              size={branchesWidth}
              min={160}
              max={Math.max(200, Math.round(width * 0.35))}
              defaultSize={230}
              onResize={setBranchesWidth}
              label="Resize branches"
            />
          </>
        ) : null}
        <GraphPane
          className={styles.graph}
          model={model}
          animate
          highlight={highlight}
          marks={marks}
          emptyNote={emptyNote}
          graphRef={graphRef}
          label={`${tab.title} history`}
          onSelectionChange={(shas) => {
            setSelection(shas);
            setPinned(undefined);
            setHover(undefined);
          }}
          onContextMenu={(row, x, y) => {
            setHover(undefined);
            const ctx = context();
            if (ctx) showRowMenu(ctx, row, x, y);
          }}
          onOpen={onOpen}
          onHover={(row, rect) => setHover(row === undefined || !rect ? undefined : { row, rect })}
          onRefClick={(ref, event) => {
            setHover(undefined);
            const ctx = context();
            if (ctx) showRefMenu(ctx, ref, event);
          }}
          onDrop={(item, row, x, y) => {
            const ctx = context();
            if (ctx) showDropMenu(ctx, item, row, x, y);
          }}
        />
        {details ? (
          <>
            {detailsCollapsed ? null : (
              <Splitter
                orientation={stacked ? 'horizontal' : 'vertical'}
                size={stacked ? detailsHeight : detailsWidth}
                min={stacked ? 120 : 260}
                max={stacked ? 640 : Math.max(320, Math.round(width * 0.6))}
                defaultSize={stacked ? 240 : 380}
                onResize={stacked ? setDetailsHeight : setDetailsWidth}
                label="Resize details"
              />
            )}
            {details}
          </>
        ) : null}
      </div>
      {hover && model && active && !rewrite ? (
        <HoverCard repoId={repoId} model={model} target={hover} />
      ) : null}
      <AnimatePresence>
        {rewrite ? (
          <HistoryEditor key={rewrite.id} session={rewrite} model={source} color={branchColor} />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
