import { useState, type RefObject } from 'react';
import type { RefScope, ViewConfig } from '../../../shared/models';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { openMenu, type MenuEntry } from '../../components/Menu';
import { openPicker } from '../../components/Picker';
import { SCOPE_ICONS } from '../../components/TabStrip';
import { columnToggleEntries, useGraphColumns } from '../../graph/columnMenus';
import type { LogModel } from '../../graph/logModel';
import { useApp } from '../../state/store';
import { scopeTitle, type TabModel } from '../../state/tabs';
import { customRefOrPattern, refPickerItems } from '../refItems';
import { useModelVersion } from './parts';
import type { SearchMatches } from './useLogSearch';
import { shortRefName, viewLabel } from './viewRefs';
import styles from './LogToolbar.module.css';

export function scopeLabel(scope: RefScope): string {
  return viewLabel({ scope });
}

/** Applies a view change to a tab, retitling it when it still has its automatic title. */
export function updateView(tab: TabModel, view: ViewConfig): void {
  const automatic = !tab.view || tab.title === scopeTitle(tab.view.scope);
  useApp.getState().updateTab(tab.id, { view, ...(automatic ? { title: scopeTitle(view.scope) } : {}) });
}

const OPERATORS: readonly { token: string; label: string }[] = [
  { token: '@', label: 'author' },
  { token: '#', label: 'hash' },
  { token: 'message:', label: 'message only' },
  { token: 'file:', label: 'touches path' },
  { token: 'after:', label: 'date' },
  { token: 'before:', label: 'date' },
];

export interface SearchBoxProps {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly pending: boolean;
  readonly error?: string;
  readonly matches?: SearchMatches;
  readonly matchCount: number;
  readonly matchIndex: number;
  readonly onStep: (delta: number) => void;
  readonly onEscape: () => void;
}

export function SearchBox({
  inputRef,
  text,
  onText,
  pending,
  error,
  matches,
  matchCount,
  matchIndex,
  onStep,
  onEscape,
}: SearchBoxProps) {
  // Focus anywhere in the box or its tips: Tab moves from the input to the tips, which stay.
  const [focused, setFocused] = useState(false);
  const hasQuery = text.trim() !== '';
  let status: string | undefined;
  if (hasQuery && !pending) {
    if (error) status = 'Error';
    else if (matches)
      status =
        matchCount === 0
          ? 'No results'
          : `${matchIndex >= 0 ? `${matchIndex + 1} of ` : ''}${matchCount.toLocaleString()}${matches.truncated ? '+' : ''}`;
  }
  return (
    <div
      className={styles.searchWrap}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <label className={styles.search} data-error={!!error} title={error}>
        <Icon name={pending && hasQuery ? 'loading' : 'search'} spin={pending && hasQuery} />
        <input
          ref={inputRef}
          value={text}
          placeholder="Search commits"
          aria-label="Search commits: text, @author, #hash, file:path, after:date"
          spellCheck={false}
          onChange={(event) => onText(event.target.value)}
          onKeyDown={(event) => {
            // Keys that drive an input method's composition are not commands.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' || event.key === 'F3') onStep(event.shiftKey ? -1 : 1);
            else if (event.key === 'Escape') onEscape();
            else if (event.key === 'ArrowDown') onStep(1);
            else if (event.key === 'ArrowUp') onStep(-1);
            else return;
            event.preventDefault();
          }}
        />
        {status ? (
          <span className={styles.status} data-empty={matchCount === 0}>
            {status}
          </span>
        ) : null}
        {hasQuery ? (
          <span className={styles.searchActions}>
            <button
              type="button"
              className={styles.miniButton}
              aria-label="Previous match"
              title="Previous match (Shift+Enter)"
              disabled={matchCount === 0}
              onClick={() => onStep(-1)}
            >
              <Icon name="arrow-up" />
            </button>
            <button
              type="button"
              className={styles.miniButton}
              aria-label="Next match"
              title="Next match (Enter)"
              disabled={matchCount === 0}
              onClick={() => onStep(1)}
            >
              <Icon name="arrow-down" />
            </button>
            <button
              type="button"
              className={styles.miniButton}
              aria-label="Clear search"
              title="Clear (Escape)"
              onClick={() => onEscape()}
            >
              <Icon name="close" />
            </button>
          </span>
        ) : null}
      </label>
      {focused && !hasQuery ? (
        <div
          className={styles.hints}
          role="group"
          aria-label="Search operators"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <span className={styles.hintsTitle}>Search messages and authors, or narrow with</span>
          {OPERATORS.map((op) => (
            <button
              key={op.token}
              type="button"
              className={styles.hint}
              // Keep focus in the input while inserting the operator (clicked or from the keyboard).
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onText(op.token);
                inputRef.current?.focus();
              }}
            >
              <code>{op.token}</code> {op.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * How many commits the view has (still loading: so far); filtering, how many of them it shows
 * (`shown`: the filtered model).
 */
export function LogStats({ model, shown }: { model: LogModel | undefined; shown?: LogModel }) {
  useModelVersion(model);
  if (!model) return null;
  const count = model.topology.rowCount - (model.hasWorkingTreeRow ? 1 : 0);
  const streaming = model.phase === 'streaming' || model.phase === 'opening';
  return (
    <span
      className={styles.stats}
      title={
        shown
          ? 'Commits that match the search, of all the commits in this view'
          : model.phase === 'ready'
            ? `Loaded in ${Math.round(model.loadMs)} ms`
            : undefined
      }
    >
      {streaming ? <Icon name="loading" spin /> : null}
      {shown ? `${shown.topology.rowCount.toLocaleString()} of ` : ''}
      {count.toLocaleString()} commit{count === 1 ? '' : 's'}
    </span>
  );
}

/** What a file, folder or line history view is limited to, with a button to lift the limit. */
function LimitChip({ tab }: { tab: TabModel }) {
  const view = tab.view!;
  const lines = view.lines;
  const paths = view.paths ?? [];
  if (!lines && paths.length === 0) return null;
  const label = lines
    ? `${lines.path}:${lines.start === lines.end ? lines.start : `${lines.start}–${lines.end}`}`
    : paths.length === 1
      ? paths[0]!
      : `${paths[0]} +${paths.length - 1}`;
  const title = lines
    ? `Commits that changed these lines (git log -L${lines.start},${lines.end}:${lines.path})`
    : `Commits that touch ${paths.join(', ')} (git log -- ${paths.join(' ')})`;
  return (
    <span className={styles.limit} title={title}>
      <Icon name={lines ? 'list-selection' : 'history'} />
      <span className={styles.chipLabel}>{label}</span>
      <button
        type="button"
        className={styles.limitClear}
        aria-label={lines ? 'Show the whole history instead of these lines' : 'Show the whole history'}
        title="Show the whole history"
        onClick={() => updateView(tab, { ...view, lines: undefined, paths: undefined })}
      >
        <Icon name="close" />
      </button>
    </span>
  );
}

export interface LogToolbarProps {
  readonly tab: TabModel;
  readonly source: LogModel | undefined;
  /** The commits a filtering search leaves (undefined when not filtering). */
  readonly filtered?: LogModel;
  readonly search: SearchBoxProps;
  readonly filterMode: boolean;
  readonly onFilterMode: (filter: boolean) => void;
  readonly pinned?: { readonly label: string; readonly onClear: () => void };
  readonly detailsOpen: boolean;
  readonly onToggleDetails: () => void;
  /** The branches pane: shown, or undefined when the view is too narrow for it. */
  readonly branchesOpen?: boolean;
  readonly onToggleBranches?: () => void;
}

export function LogToolbar({
  tab,
  source,
  filtered,
  search,
  filterMode,
  onFilterMode,
  pinned,
  detailsOpen,
  onToggleDetails,
  branchesOpen,
  onToggleBranches,
}: LogToolbarProps) {
  const view = tab.view!;

  const scopeMenu = (anchor: Element) => {
    // Refs added to a view belong to its old scope (choosing that again resets it).
    const setScope = (scope: RefScope) => updateView(tab, { ...view, scope, extra: undefined });
    // What the view shows now, as the picker names refs.
    const chosen =
      view.scope.type === 'refs'
        ? view.scope.refs
        : view.scope.type === 'head'
          ? ['HEAD', ...(view.extra ?? []).map(shortRefName)]
          : [];
    const entries: MenuEntry[] = [
      { kind: 'header', label: 'Show commits from' },
      {
        id: 'all',
        label: 'All branches',
        icon: 'source-control',
        hint: '--branches --remotes --tags HEAD',
        checked: view.scope.type === 'all',
        onSelect: () => setScope({ type: 'all' }),
      },
      {
        id: 'head',
        label: 'Current branch',
        icon: 'target',
        hint: 'HEAD',
        checked: view.scope.type === 'head',
        onSelect: () => setScope({ type: 'head' }),
      },
      {
        id: 'local',
        label: 'Local branches',
        icon: 'repo',
        hint: '--branches HEAD',
        checked: view.scope.type === 'local',
        onSelect: () => setScope({ type: 'local' }),
      },
      { kind: 'separator' },
      {
        id: 'choose',
        label: 'Choose branches…',
        icon: 'git-branch',
        checked: view.scope.type === 'refs',
        onSelect: () => {
          if (!source) return;
          openPicker(anchor, {
            title: 'Branches to show',
            placeholder: 'Filter branches and tags, or type a glob (feature/*)',
            items: refPickerItems(source.refs, { includeHead: true }),
            multi: true,
            selected: chosen,
            custom: customRefOrPattern,
            applyLabel: 'Show',
            onPick: (refs) => refs.length > 0 && setScope({ type: 'refs', refs }),
          });
        },
      },
    ];
    openMenu(anchor, entries);
  };

  const optionsMenu = (anchor: Element) => {
    const set = (patch: Partial<ViewConfig>) => updateView(tab, { ...view, ...patch });
    const order = view.order ?? useApp.getState().settings.logOrder;
    openMenu(anchor, [
      { kind: 'header', label: 'Order' },
      {
        id: 'topo',
        label: 'Keep branches together',
        hint: '--topo-order',
        checked: order === 'topo',
        onSelect: () => set({ order: 'topo' }),
      },
      {
        id: 'date',
        label: 'By commit date',
        hint: '--date-order',
        checked: order === 'date',
        onSelect: () => set({ order: 'date' }),
      },
      { kind: 'separator' },
      {
        id: 'first-parent',
        label: 'First parent only',
        hint: '--first-parent',
        checked: !!view.firstParent,
        onSelect: () => set({ firstParent: !view.firstParent }),
      },
      {
        id: 'no-merges',
        label: 'Hide merge commits',
        hint: '--no-merges',
        checked: !!view.noMerges,
        onSelect: () => set({ noMerges: !view.noMerges }),
      },
      // The same in every view; the headings' own menu also moves them.
      { kind: 'separator' },
      { kind: 'header', label: 'Columns' },
      ...columnToggleEntries(useGraphColumns.getState().columns, {
        hint: 'In every view; drag a column heading to move it',
      }),
    ]);
  };

  const optionsActive = !!(view.firstParent || view.noMerges || view.order);

  return (
    <div className={styles.toolbar}>
      {branchesOpen !== undefined && onToggleBranches ? (
        <IconButton
          icon={branchesOpen ? 'layout-sidebar-left' : 'layout-sidebar-left-off'}
          label={branchesOpen ? 'Hide branches' : 'Show branches'}
          pressed={branchesOpen}
          onClick={onToggleBranches}
        />
      ) : null}
      <SearchBox {...search} />
      <div className={styles.segmented} role="radiogroup" aria-label="Search results">
        <button
          type="button"
          role="radio"
          aria-checked={!filterMode}
          aria-label="Highlight"
          title="Dim commits that don’t match"
          onClick={() => onFilterMode(false)}
        >
          <Icon name="eye" /> <span className={styles.segmentLabel}>Highlight</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={filterMode}
          aria-label="Filter"
          title="Show only matching commits (the graph stays connected)"
          onClick={() => onFilterMode(true)}
        >
          <Icon name="filter" /> <span className={styles.segmentLabel}>Filter</span>
        </button>
      </div>
      {pinned ? (
        <span className={styles.pinned}>
          <Icon name="symbol-color" />
          {pinned.label}
          <button
            type="button"
            className={styles.miniButton}
            aria-label="Clear highlight"
            onClick={pinned.onClear}
          >
            <Icon name="close" />
          </button>
        </span>
      ) : null}
      <div className={styles.spacer} />
      <button
        type="button"
        className={styles.chip}
        onClick={(event) => scopeMenu(event.currentTarget)}
        title={`Branches this view shows: ${viewLabel(view)}`}
      >
        <Icon name={SCOPE_ICONS[view.scope.type]} />
        <span className={styles.chipLabel}>{viewLabel(view)}</span>
        <Icon name="chevron-down" className={styles.chevron} />
      </button>
      <LimitChip tab={tab} />
      <IconButton
        icon="settings"
        label="View options"
        pressed={optionsActive}
        onClick={(event) => optionsMenu(event.currentTarget)}
      />
      <LogStats model={source} shown={filtered} />
      <IconButton
        icon={detailsOpen ? 'layout-sidebar-right' : 'layout-sidebar-right-off'}
        label={detailsOpen ? 'Hide details' : 'Show details'}
        pressed={detailsOpen}
        onClick={onToggleDetails}
      />
    </div>
  );
}
