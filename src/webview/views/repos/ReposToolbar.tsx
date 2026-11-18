import type { CSSProperties } from 'react';
import type { RefScope, ViewConfig } from '../../../shared/models';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { openMenu, type MenuEntry } from '../../components/Menu';
import { segmentedClass } from '../../components/Segmented';
import { SCOPE_ICONS } from '../../components/TabStrip';
import { toast } from '../../components/Toast';
import type { ThemeKind } from '../../graph/palette';
import { repoColor } from '../../graph/repoColors';
import type { ReposLogModel } from '../../graph/reposLogModel';
import { useApp } from '../../state/store';
import type { TabModel } from '../../state/tabs';
import { useThemeKind } from '../../state/theme';
import { LogStats, scopeLabel, SearchBox, type SearchBoxProps } from '../log/LogToolbar';
import { useModelVersion } from '../log/parts';
import type { RepoStore } from './reposTab';
import toolbar from '../log/LogToolbar.module.css';
import styles from './ReposLogView.module.css';

/** The scopes a log of several repositories offers (branch names differ between repositories). */
const SCOPES: readonly { type: RefScope['type']; hint: string }[] = [
  { type: 'all', hint: '--branches --remotes --tags HEAD' },
  { type: 'local', hint: '--branches HEAD' },
  { type: 'head', hint: 'HEAD' },
];

/** Why a repository has no rows, if it has none: its history could not be read, or it has no commits. */
function noteOf(model: ReposLogModel | undefined, store: RepoStore): { problem?: string; empty?: boolean } {
  const source = model?.sources.find((candidate) => candidate.repoId === store.id);
  if (!source) return {};
  const problem = source.error ?? model!.sourceErrors[source.index];
  if (problem) return { problem };
  return { empty: source.refs.refs.length === 0 && source.heads.every((head) => head.unborn) };
}

/** "aurora (and 1 more worktree)". */
function fullName(store: RepoStore): string {
  const worktrees = store.members.length - 1;
  return `${store.name}${worktrees > 0 ? ` (and ${worktrees} more worktree${worktrees === 1 ? '' : 's'})` : ''}`;
}

/**
 * The legend of the log: one toggle per repository, in its color. Pressed ones are shown;
 * the last one shown stays. With a single repository it only names it. In a narrow panel the
 * legend is a button whose menu lists the repositories, colors and all.
 */
function RepoLegend({
  tab,
  stores,
  hidden,
  model,
}: {
  tab: TabModel;
  stores: readonly RepoStore[];
  hidden: (store: RepoStore) => boolean;
  model: ReposLogModel | undefined;
}) {
  useModelVersion(model);
  const kind = useThemeKind();
  const shownCount = stores.filter((store) => !hidden(store)).length;
  const setHidden = (ids: Iterable<string>) => useApp.getState().updateTab(tab.id, { hiddenRepos: [...ids] });
  const toggle = (store: RepoStore) => {
    const hide = !hidden(store);
    if (hide && shownCount === 1) {
      toast('This view shows at least one repository', { detail: 'Show another one first.' });
      return;
    }
    const ids = new Set(tab.hiddenRepos);
    for (const member of store.members) {
      if (hide) ids.add(member.id);
      else ids.delete(member.id);
    }
    setHidden(ids);
  };
  const menu = (store: RepoStore, x: number, y: number) => {
    const entries: MenuEntry[] = [
      { kind: 'title', label: store.name },
      {
        id: 'only',
        label: 'Show only this repository',
        icon: 'filter',
        disabled: shownCount === 1 && !hidden(store),
        reason: 'It is the only one shown',
        onSelect: () =>
          setHidden(stores.flatMap((other) => (other === store ? [] : other.members.map((m) => m.id)))),
      },
      {
        id: 'all',
        label: 'Show every repository',
        icon: 'eye',
        disabled: shownCount === stores.length,
        reason: 'Every repository is shown',
        onSelect: () => setHidden([]),
      },
      { kind: 'separator' },
      {
        id: 'switch',
        label: `Switch to ${store.name}`,
        icon: 'repo-selected',
        onSelect: () => useApp.getState().selectRepo(store.id),
      },
    ];
    openMenu({ x, y }, entries);
  };
  const listMenu = (anchor: Element) =>
    openMenu(anchor, [
      { kind: 'header', label: 'Repositories in this view' },
      ...stores.map((store): MenuEntry => {
        const shown = !hidden(store);
        const { problem, empty } = shown ? noteOf(model, store) : {};
        return {
          id: store.id,
          label: `${fullName(store)}${problem ? ': could not be read' : empty ? ': no commits yet' : ''}`,
          swatch: repoColor(store.colorIndex, kind),
          checked: shown,
          // The last one shown stays.
          disabled: shown && shownCount === 1,
          reason: 'The view shows at least one repository',
          onSelect: () => toggle(store),
        };
      }),
      ...(stores.length > 1
        ? ([
            { kind: 'separator' },
            {
              id: 'all',
              label: 'Show every repository',
              icon: 'eye',
              disabled: shownCount === stores.length,
              reason: 'Every repository is shown',
              onSelect: () => setHidden([]),
            },
          ] satisfies MenuEntry[])
        : []),
    ]);
  const shownStores = stores.filter((store) => !hidden(store));

  return (
    <>
      <button
        type="button"
        className={styles.legendButton}
        aria-label="Repositories in this view"
        title={`Repositories in this view: ${shownStores.map((store) => store.name).join(', ')}`}
        onClick={(event) => listMenu(event.currentTarget)}
      >
        <span className={styles.swatches} aria-hidden="true">
          {shownStores.slice(0, 4).map((store) => (
            <span
              key={store.id}
              className={styles.swatch}
              style={{ '--lf-repo': repoColor(store.colorIndex, kind) } as CSSProperties}
            />
          ))}
        </span>
        <Icon name="chevron-down" className={toolbar.chevron} />
      </button>
      <RepoChips stores={stores} hidden={hidden} model={model} kind={kind} onToggle={toggle} onMenu={menu} />
    </>
  );
}

/** The legend as chips: one toggle per repository (wide enough panels). */
function RepoChips({
  stores,
  hidden,
  model,
  kind,
  onToggle,
  onMenu,
}: {
  stores: readonly RepoStore[];
  hidden: (store: RepoStore) => boolean;
  model: ReposLogModel | undefined;
  kind: ThemeKind;
  onToggle: (store: RepoStore) => void;
  onMenu: (store: RepoStore, x: number, y: number) => void;
}) {
  return (
    <div className={styles.legend} role="group" aria-label="Repositories in this view">
      {stores.map((store) => {
        const shown = !hidden(store);
        const { problem, empty } = shown ? noteOf(model, store) : {};
        const name = fullName(store);
        const note = problem
          ? `its history could not be read. ${problem}`
          : empty
            ? 'no commits yet.'
            : undefined;
        const content = (
          <>
            <span
              className={styles.swatch}
              style={{ '--lf-repo': repoColor(store.colorIndex, kind) } as CSSProperties}
              aria-hidden="true"
            />
            <span className={styles.repoName}>{store.name}</span>
            {problem ? <Icon name="warning" className={styles.problem} /> : null}
          </>
        );
        if (stores.length === 1)
          return (
            <span
              key={store.id}
              className={styles.repo}
              data-static=""
              title={note ? `${name}: ${note}` : name}
            >
              {content}
            </span>
          );
        const title = !shown
          ? `${name}: left out. Click to show its commits.`
          : note
            ? `${name}: ${note} Click to leave it out.`
            : `${name}: shown. Click to leave its commits out.`;
        return (
          <button
            key={store.id}
            type="button"
            className={styles.repo}
            aria-pressed={shown}
            data-empty={empty ? '' : undefined}
            title={title}
            onClick={() => onToggle(store)}
            onContextMenu={(event) => {
              event.preventDefault();
              onMenu(store, event.clientX, event.clientY);
            }}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

export interface ReposToolbarProps {
  readonly tab: TabModel;
  readonly source: ReposLogModel | undefined;
  /** The commits a filtering search leaves (undefined when not filtering). */
  readonly filtered?: ReposLogModel;
  readonly stores: readonly RepoStore[];
  readonly hidden: (store: RepoStore) => boolean;
  readonly search: SearchBoxProps;
  readonly filterMode: boolean;
  readonly onFilterMode: (filter: boolean) => void;
  readonly pinned?: { readonly label: string; readonly onClear: () => void };
  readonly detailsOpen: boolean;
  readonly onToggleDetails: () => void;
}

/** The toolbar of the "All repositories" view: search, legend and filter, what it shows. */
export function ReposToolbar({
  tab,
  source,
  filtered,
  stores,
  hidden,
  search,
  filterMode,
  onFilterMode,
  pinned,
  detailsOpen,
  onToggleDetails,
}: ReposToolbarProps) {
  const view = tab.view!;
  const setView = (next: ViewConfig) => useApp.getState().updateTab(tab.id, { view: next });

  const scopeMenu = (anchor: Element) =>
    openMenu(anchor, [
      { kind: 'header', label: 'Show commits from' },
      ...SCOPES.map(({ type, hint }): MenuEntry => ({
        id: type,
        label: scopeLabel({ type } as RefScope),
        icon: SCOPE_ICONS[type],
        hint,
        checked: view.scope.type === type,
        onSelect: () => setView({ ...view, scope: { type } as RefScope }),
      })),
    ]);

  const optionsMenu = (anchor: Element) =>
    openMenu(anchor, [
      { kind: 'header', label: 'Order' },
      {
        // The only order several repositories can be merged in.
        id: 'date',
        label: 'By commit date, across repositories',
        checked: true,
        disabled: true,
        reason: 'The only order several repositories can be merged in',
        onSelect: () => undefined,
      },
      { kind: 'separator' },
      {
        id: 'first-parent',
        label: 'First parent only',
        hint: '--first-parent',
        checked: !!view.firstParent,
        onSelect: () => setView({ ...view, firstParent: !view.firstParent }),
      },
      {
        id: 'no-merges',
        label: 'Hide merge commits',
        hint: '--no-merges',
        checked: !!view.noMerges,
        onSelect: () => setView({ ...view, noMerges: !view.noMerges }),
      },
    ]);

  return (
    <div className={toolbar.toolbar}>
      <SearchBox {...search} />
      <div className={segmentedClass('small')} role="radiogroup" aria-label="Search results">
        <button
          type="button"
          role="radio"
          aria-checked={!filterMode}
          aria-label="Highlight"
          title="Dim commits that don’t match"
          onClick={() => onFilterMode(false)}
        >
          <Icon name="eye" /> <span className={toolbar.segmentLabel}>Highlight</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={filterMode}
          aria-label="Filter"
          title="Show only matching commits (the graph stays connected)"
          onClick={() => onFilterMode(true)}
        >
          <Icon name="filter" /> <span className={toolbar.segmentLabel}>Filter</span>
        </button>
      </div>
      {pinned ? (
        <span className={toolbar.pinned}>
          <Icon name="symbol-color" />
          {pinned.label}
          <button
            type="button"
            className={toolbar.miniButton}
            aria-label="Clear highlight"
            onClick={pinned.onClear}
          >
            <Icon name="close" />
          </button>
        </span>
      ) : null}
      <div className={toolbar.spacer} />
      <RepoLegend tab={tab} stores={stores} hidden={hidden} model={source} />
      <button
        type="button"
        className={toolbar.chip}
        onClick={(event) => scopeMenu(event.currentTarget)}
        title={`Branches of each repository this view shows: ${scopeLabel(view.scope)}`}
      >
        <Icon name={SCOPE_ICONS[view.scope.type]} />
        <span className={toolbar.chipLabel}>{scopeLabel(view.scope)}</span>
        <Icon name="chevron-down" className={toolbar.chevron} />
      </button>
      <IconButton
        icon="settings"
        label="View options"
        pressed={!!(view.firstParent || view.noMerges)}
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
