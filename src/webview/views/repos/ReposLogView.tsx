import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { Splitter, usePersistentSize } from '../../components/Splitter';
import { toast } from '../../components/Toast';
import { isWorkingTreeSha } from '../../graph/format';
import { GraphPane } from '../../graph/GraphPane';
import type { EmptyNote, GraphView, Highlight } from '../../graph/GraphView';
import type { ThemeKind } from '../../graph/palette';
import { preferredSlot } from '../../graph/repoColorSlots';
import { repoColor } from '../../graph/repoColors';
import type { LogSource, ReposLogModel } from '../../graph/reposLogModel';
import { useHost } from '../../hostContext';
import { useApp } from '../../state/store';
import type { TabModel } from '../../state/tabs';
import { useThemeKind } from '../../state/theme';
import { DetailsPane } from '../log/DetailsPane';
import { HoverCard, type HoverTarget } from '../log/HoverCard';
import { openCommitChanges, openCompareTab, openFileHistoryTab } from '../log/logMenus';
import { STACK_BELOW, usePersistentFlag, useWidth } from '../log/LogView';
import { CommitChip, copyWithToast } from '../log/parts';
import { useFilteredModel, useLogSearch, type SearchMatches } from '../log/useLogSearch';
import { showReposRefMenu, showReposRowMenu } from './reposMenus';
import { inRepository, repoStores, showInRepository, type RepoStore } from './reposTab';
import { ReposToolbar } from './ReposToolbar';
import { useReposLogModel } from './useReposLogModel';
import logStyles from '../log/LogView.module.css';
import styles from './ReposLogView.module.css';

function swatch(source: LogSource, kind: ThemeKind): CSSProperties {
  return { '--lf-repo': repoColor(source.colorIndex, kind) } as CSSProperties;
}

/** Names in a sentence: "a", "a and b", "a, b and c". */
function names(list: readonly string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Which repository the selected commits are in, with "Show in" (it switches to it). */
function RepoBar({ source, sha, kind }: { source: LogSource; sha: string; kind: ThemeKind }) {
  const worktrees = source.worktrees.length;
  return (
    <div className={styles.repoBar}>
      <span className={styles.swatch} style={swatch(source, kind)} aria-hidden="true" />
      <span className={styles.repoBarName} title={source.repoId}>
        {source.name}
      </span>
      {worktrees > 0 ? (
        <span className={styles.muted}>
          +{worktrees} worktree{worktrees === 1 ? '' : 's'}
        </span>
      ) : null}
      <button
        type="button"
        className={styles.showIn}
        title={`Switch to ${source.name} and select this commit in its log, where it can be changed`}
        onClick={() => showInRepository(source.repoId, sha)}
      >
        <Icon name="repo-selected" />
        <span className={styles.showInLabel}>Show in {source.name}</span>
      </button>
    </div>
  );
}

/** Commits of several repositories are selected: they cannot be compared. */
function MixedSelection({
  model,
  bySource,
  onReveal,
  kind,
}: {
  model: ReposLogModel;
  bySource: ReadonlyMap<LogSource, readonly string[]>;
  onReveal: (sha: string) => void;
  kind: ThemeKind;
}) {
  const sources = [...bySource.keys()];
  return (
    <div className={styles.mixed}>
      <EmptyState
        compact
        icon="info"
        title="Commits of different repositories"
        description={`${names(sources.map((source) => source.name))} are separate repositories, so these commits cannot be compared. Select commits of one repository to compare them or see their changes together.`}
      />
      {sources.map((source) => (
        <section key={source.repoId} className={styles.mixedGroup} aria-label={source.name}>
          <h3 className={styles.mixedTitle}>
            <span className={styles.swatch} style={swatch(source, kind)} aria-hidden="true" />
            {source.name}
          </h3>
          <div className={styles.mixedCommits}>
            {bySource.get(source)!.map((sha) => (
              <CommitChip key={sha} model={model} sha={sha} onClick={() => onReveal(sha)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export interface ReposLogViewProps {
  readonly tab: TabModel;
  /** The tab is in front (hidden tabs stay mounted but defer reloads). */
  readonly active: boolean;
}

/**
 * "All repositories": the history of every open repository in one graph, newest first, each
 * row marked with its repository. It only reads: commits are changed in their repository's own
 * log, which "Show in <repository>" opens.
 */
export function ReposLogView({ tab, active }: ReposLogViewProps) {
  const host = useHost();
  const kind = useThemeKind();
  const view = tab.view!;
  const graphRef = useRef<GraphView | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const repos = useApp((state) => state.repos);
  const stores = useMemo(() => repoStores(repos), [repos]);
  const hiddenIds = useMemo(() => new Set(tab.hiddenRepos), [tab.hiddenRepos]);
  // Every repository left out (the shown ones closed meanwhile) means none: the view always
  // shows one (the filter is cleared below).
  const noneShown = stores.every((store) => store.members.some((member) => hiddenIds.has(member.id)));
  const hidden = useCallback(
    (store: RepoStore) => !noneShown && store.members.some((member) => hiddenIds.has(member.id)),
    [hiddenIds, noneShown],
  );
  useEffect(() => {
    if (noneShown && stores.length > 0) useApp.getState().updateTab(tab.id, { hiddenRepos: [] });
  }, [noneShown, stores.length, tab.id]);
  const shown = useMemo(() => stores.filter((store) => !hidden(store)), [stores, hidden]);
  // Every worktree goes to the host (it reads each repository once); searches need one each.
  const repoIds = useMemo(() => shown.flatMap((store) => store.members.map((member) => member.id)), [shown]);
  const searchIds = useMemo(() => shown.map((store) => store.id), [shown]);
  const label = useCallback(
    (repoId: string) => {
      const store = stores.find((candidate) => candidate.members.some((member) => member.id === repoId));
      return store
        ? { name: store.name, colorIndex: store.colorIndex }
        : { name: repoId.split(/[\\/]/).pop() || repoId, colorIndex: preferredSlot(repoId) };
    },
    [stores],
  );

  const loaded = useReposLogModel(repoIds, view, active, () => graphRef.current?.topRow ?? 0, label);
  const source = loaded?.model as ReposLogModel | undefined;
  const search = useLogSearch(searchIds[0] ?? '', view, source, searchIds);
  const [filterMode, setFilterMode] = usePersistentFlag('searchFilter', false);
  const filtered = useFilteredModel(source, search.matches, filterMode) as ReposLogModel | undefined;
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

  const highlight = useMemo<Highlight | undefined>(() => {
    if (pinned) return { shas: new Set(pinned.shas), mode: 'highlight' };
    if (search.matches && !filterMode) return { shas: search.matches.shas, mode: 'highlight' };
    return undefined;
  }, [pinned, search.matches, filterMode]);
  // Filtering, every row is a match: all of them count (not only those laid out so far).
  const matchCount = filterMode ? (filtered?.topology.rowCount ?? 0) : (search.matches?.shas.size ?? 0);
  // Stacked under the graph with nothing selected, the details pane shrinks to a line.
  const detailsCollapsed = stacked && selection.length === 0;

  // A single match is where the user wants to go (a pasted hash): select it, for a new query.
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

  // Ctrl/Cmd+F and "/" focus the search box; Ctrl/Cmd+C copies the selected hashes.
  useEffect(() => {
    if (!active) return;
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

  const reveal = (sha: string) => {
    if (!graphRef.current?.goTo(sha)) toast('That commit is not in this view', { detail: sha.slice(0, 12) });
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

  const onOpen = (row: number) => {
    const graph = graphRef.current;
    const repository = model?.sourceAt(row);
    if (!graph || !model || !repository) return;
    void openCommitChanges({ rpc: host.rpc, repoId: repository.repoId, model, graph }, model.sha(row));
  };

  // The selected commits by repository: details need them all in one.
  const bySource = useMemo(() => {
    const map = new Map<LogSource, string[]>();
    for (const sha of selection) {
      const repository = model?.sourceOf(sha);
      if (!repository) continue;
      const list = map.get(repository);
      if (list) list.push(sha);
      else map.set(repository, [sha]);
    }
    return map;
  }, [model, selection]);
  const selected = bySource.size === 1 ? [...bySource.keys()][0] : undefined;

  const details =
    detailsOpen && model ? (
      <aside
        className={logStyles.details}
        style={detailsCollapsed ? undefined : stacked ? { height: detailsHeight } : { width: detailsWidth }}
        aria-label="Commit details"
      >
        {bySource.size > 1 ? (
          <MixedSelection model={model} bySource={bySource} onReveal={reveal} kind={kind} />
        ) : (
          <div className={styles.detailsColumn}>
            {selected ? <RepoBar source={selected} sha={selection[0]!} kind={kind} /> : null}
            <DetailsPane
              repoId={selected?.repoId ?? searchIds[0] ?? ''}
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
              onOpenCompare={(a, b) =>
                selected && inRepository(selected.repoId, () => openCompareTab(a, b, 'two-dot'))
              }
              scope={
                selected && {
                  repoName: selected.name,
                  openHistory: (path) => inRepository(selected.repoId, () => openFileHistoryTab(path)),
                }
              }
            />
          </div>
        )}
      </aside>
    ) : null;

  const hovered = hover && model && active ? model.sourceAt(hover.row) : undefined;

  return (
    <div ref={rootRef} className={logStyles.root}>
      <ReposToolbar
        tab={tab}
        source={source}
        filtered={filtered}
        stores={stores}
        hidden={hidden}
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
      />
      <div className={logStyles.body} data-stacked={stacked}>
        <GraphPane
          className={logStyles.graph}
          model={model}
          animate
          highlight={highlight}
          emptyNote={emptyNote}
          graphRef={graphRef}
          label={`${tab.title}: history`}
          onSelectionChange={(shas) => {
            setSelection(shas);
            setPinned(undefined);
            setHover(undefined);
          }}
          onContextMenu={(row, x, y) => {
            setHover(undefined);
            const graph = graphRef.current;
            if (graph && model) showReposRowMenu({ rpc: host.rpc, model, graph }, row, x, y);
          }}
          onOpen={onOpen}
          onHover={(row, rect) => setHover(row === undefined || !rect ? undefined : { row, rect })}
          onRefClick={(ref, event) => {
            setHover(undefined);
            const graph = graphRef.current;
            if (graph && model) showReposRefMenu({ rpc: host.rpc, model, graph }, ref, event);
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
      {hover && model && hovered ? (
        <HoverCard
          repoId={hovered.repoId}
          model={model}
          target={hover}
          repository={{ name: hovered.name, color: repoColor(hovered.colorIndex, kind) }}
        />
      ) : null}
    </div>
  );
}
