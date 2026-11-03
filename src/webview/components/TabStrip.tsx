import { motion, Reorder } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { RefScope } from '../../shared/models';
import { hostRpc, showStashes, useApp } from '../state/store';
import { CONSOLE_TAB_ID, HEAD_TITLE, plainLogTab, scopeTitle, tabTitles, type TabModel } from '../state/tabs';
import { focusWhenShown } from '../state/viewFocus';
import { customRefOrPattern, customRevision, refPickerItems } from '../views/refItems';
import { openReposTab, REPOS_ICON } from '../views/repos/reposTab';
import { openStats, STATS_ICON } from '../views/stats/statsTab';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { openMenu, type MenuEntry } from './Menu';
import { openPicker } from './Picker';
import styles from './TabStrip.module.css';

export const SCOPE_ICONS: Record<RefScope['type'], string> = {
  all: 'source-control',
  head: 'target',
  local: 'repo',
  refs: 'git-branch',
};

export function tabIcon(tab: TabModel): string {
  if (tab.kind === 'console') return 'terminal';
  if (tab.kind === 'compare') return 'git-compare';
  if (tab.kind === 'stashes') return 'git-stash';
  if (tab.kind === 'reflog') return 'history';
  if (tab.kind === 'repos') return REPOS_ICON;
  if (tab.kind === 'stats') return STATS_ICON;
  if (tab.view?.lines) return 'list-selection';
  if (tab.view?.paths?.length) return 'history';
  return SCOPE_ICONS[tab.view?.scope.type ?? 'all'];
}

/** The history of a scope: the tab that shows it as it comes, else a new one. */
function showScope(title: string, scope: RefScope): void {
  const { tabs, activateTab, addTab } = useApp.getState();
  const existing = plainLogTab(tabs.tabs, scope);
  if (existing) activateTab(existing.id);
  else addTab({ kind: 'log', title, view: { scope } });
}

/** Activates the Reflog tab, opening one if there is none; its list takes keyboard focus. */
function showReflog(): void {
  focusWhenShown('reflog');
  const { tabs, activateTab, addTab } = useApp.getState();
  const existing = tabs.tabs.find((tab) => tab.kind === 'reflog');
  if (existing) activateTab(existing.id);
  else addTab({ kind: 'reflog', title: 'Reflog' });
}

const INDICATOR_SPRING = { type: 'spring', stiffness: 520, damping: 40, mass: 0.6 } as const;

export function TabStrip() {
  const tabs = useApp((state) => state.tabs);
  // Current-branch views are named after the branch checked out.
  const branch = useApp((state) =>
    state.activeRepoId ? state.heads[state.activeRepoId]?.branch : undefined,
  );
  const { activateTab, closeTab, addTab, moveTab, setTabOrder, showConsole, updateTab } = useApp.getState();
  const stripRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | undefined>();

  // The tab in front is in sight, also when a narrow strip scrolls (a view opened from a menu).
  useEffect(() => {
    const strip = scrollRef.current;
    const tab = strip?.querySelector('[role="tab"][aria-selected="true"]');
    if (!strip || !tab) return;
    const outer = strip.getBoundingClientRect();
    const inner = tab.getBoundingClientRect();
    if (inner.left < outer.left) strip.scrollLeft -= outer.left - inner.left;
    else if (inner.right > outer.right) strip.scrollLeft += inner.right - outer.right;
  }, [tabs.activeTabId]);
  const titles = tabTitles(tabs.tabs, branch);
  const titleOf = (tab: TabModel) => titles.get(tab.id) ?? tab.title;

  const tabMenu = (tab: TabModel, x: number, y: number) => {
    const others = tabs.tabs.filter((t) => t.id !== tab.id);
    openMenu({ x, y }, [
      {
        id: 'rename',
        label: 'Rename',
        icon: 'edit',
        shortcut: 'F2',
        disabled: tab.kind === 'console',
        reason: 'The Git Console keeps its name',
        onSelect: () => setRenaming(tab.id),
      },
      {
        id: 'duplicate',
        label: 'Duplicate',
        icon: 'copy',
        disabled:
          tab.kind === 'console' ||
          tab.kind === 'stashes' ||
          tab.kind === 'reflog' ||
          tab.kind === 'repos' ||
          tab.kind === 'stats',
        reason: 'There is one of this view at most',
        onSelect: () =>
          addTab({
            kind: tab.kind,
            title: tab.title,
            view: tab.view,
            compare: tab.compare,
            hiddenRepos: tab.hiddenRepos,
            search: tab.search,
          }),
      },
      { kind: 'separator' },
      {
        id: 'close',
        label: 'Close',
        shortcut: 'Delete',
        disabled: tabs.tabs.length === 1,
        reason: 'The last tab stays open',
        onSelect: () => closeTab(tab.id),
      },
      {
        id: 'close-others',
        label: 'Close others',
        disabled: others.length === 0,
        reason: 'It is the only tab',
        onSelect: () => {
          activateTab(tab.id);
          for (const other of others) closeTab(other.id);
        },
      },
    ]);
  };

  const focusTab = (index: number) => {
    const elements = stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    elements?.[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, tab: TabModel, index: number) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = (index + delta + tabs.tabs.length) % tabs.tabs.length;
      if (event.altKey) moveTab(tab.id, next);
      else {
        activateTab(tabs.tabs[next]!.id);
        focusTab(next);
      }
    } else if (event.key === 'Delete') {
      // Focus moves on to the tab that takes its place (the next one, or the new last one).
      const next = Math.min(index, tabs.tabs.length - 2);
      closeTab(tab.id);
      if (next >= 0) requestAnimationFrame(() => focusTab(next));
    } else if (event.key === 'F2' && tab.kind !== 'console') {
      setRenaming(tab.id);
    } else if (event.key === 'Home' || event.key === 'End') {
      const next = event.key === 'Home' ? 0 : tabs.tabs.length - 1;
      activateTab(tabs.tabs[next]!.id);
      focusTab(next);
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      // The tab's menu from the keyboard, under the tab.
      const rect = event.currentTarget.getBoundingClientRect();
      tabMenu(tab, rect.left + 8, rect.bottom);
    } else return;
    event.preventDefault();
  };

  const newTabMenu = (anchor: Element) => {
    const entries: MenuEntry[] = [
      { kind: 'header', label: 'New view' },
      {
        id: 'all',
        label: 'All branches',
        icon: SCOPE_ICONS.all,
        hint: 'git log --branches --remotes --tags HEAD',
        onSelect: () => showScope('All', { type: 'all' }),
      },
      {
        id: 'head',
        label: 'Current branch',
        icon: SCOPE_ICONS.head,
        hint: 'git log HEAD',
        onSelect: () => showScope(HEAD_TITLE, { type: 'head' }),
      },
      {
        id: 'local',
        label: 'Local branches',
        icon: SCOPE_ICONS.local,
        hint: 'git log --branches HEAD',
        onSelect: () => showScope('Local', { type: 'local' }),
      },
      {
        id: 'branch',
        label: 'Branch or tag…',
        icon: 'git-branch',
        hint: 'git log <ref>',
        onSelect: () => {
          const repoId = useApp.getState().activeRepoId;
          if (!repoId) return;
          void hostRpc()
            .call('repo.refs', { repoId })
            .then((refs) =>
              openPicker(anchor, {
                title: 'Show history of',
                placeholder: 'Branch, tag or commit hash',
                items: refPickerItems(refs, { includeHead: true }),
                custom: customRevision,
                onPick: ([ref]) => ref && showScope(ref, { type: 'refs', refs: [ref] }),
              }),
            );
        },
      },
      {
        id: 'branches',
        label: 'Several branches…',
        icon: 'checklist',
        hint: 'git log <ref> <ref>…',
        onSelect: () => {
          const repoId = useApp.getState().activeRepoId;
          if (!repoId) return;
          void hostRpc()
            .call('repo.refs', { repoId })
            .then((refs) =>
              openPicker(anchor, {
                title: 'Branches to show',
                placeholder: 'Filter branches and tags, or type a glob (feature/*)',
                items: refPickerItems(refs, { includeHead: true }),
                multi: true,
                custom: customRefOrPattern,
                applyLabel: 'Show',
                onPick: (chosen) => {
                  if (chosen.length === 0) return;
                  const scope = { type: 'refs', refs: chosen } as const;
                  showScope(scopeTitle(scope), scope);
                },
              }),
            );
        },
      },
      ...(useApp.getState().repos.length > 1
        ? ([
            {
              id: 'repos',
              label: 'All repositories',
              icon: REPOS_ICON,
              hint: 'git log --date-order, in each repository',
              onSelect: openReposTab,
            },
          ] satisfies MenuEntry[])
        : []),
      { kind: 'separator' },
      {
        id: 'compare',
        label: 'Compare branches…',
        icon: 'git-compare',
        hint: 'git diff A...B',
        onSelect: () => {
          const { activeRepoId, heads } = useApp.getState();
          const head = activeRepoId ? heads[activeRepoId] : undefined;
          const compare = { a: head?.branch ?? 'HEAD', b: '', mode: 'three-dot' as const };
          focusWhenShown('compare');
          addTab({ kind: 'compare', title: 'Compare', compare });
        },
      },
      {
        id: 'stashes',
        label: 'Stashes',
        icon: 'git-stash',
        hint: 'git stash list',
        onSelect: showStashes,
      },
      {
        id: 'reflog',
        label: 'Reflog (recover lost commits)',
        icon: 'history',
        hint: 'git reflog',
        onSelect: showReflog,
      },
      {
        id: 'stats',
        label: 'Statistics',
        icon: STATS_ICON,
        hint: 'git log --numstat',
        onSelect: () => openStats(),
      },
    ];
    if (!tabs.tabs.some((tab) => tab.id === CONSOLE_TAB_ID)) {
      entries.push(
        { kind: 'separator' },
        { id: 'console', label: 'Git Console', icon: 'terminal', onSelect: showConsole },
      );
    }
    openMenu(anchor, entries);
  };

  return (
    // The tab list holds tabs only; the "New view" button scrolls along beside it.
    <div ref={scrollRef} className={styles.strip}>
      <Reorder.Group
        as="div"
        axis="x"
        ref={stripRef}
        role="tablist"
        aria-label="Views"
        className={styles.tabs}
        values={tabs.tabs as TabModel[]}
        onReorder={(order: TabModel[]) => setTabOrder(order)}
      >
        {tabs.tabs.map((tab, index) => {
          const active = tab.id === tabs.activeTabId;
          const title = titleOf(tab);
          // A current-branch view named after the branch says so in its tooltip.
          const current = tab.kind === 'log' && tab.view?.scope.type === 'head' && tab.title === HEAD_TITLE;
          return (
            <Reorder.Item
              as="div"
              key={tab.id}
              value={tab}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={styles.tab}
              title={
                current ? (branch ? `Current branch: ${branch}` : 'Current commit (detached HEAD)') : title
              }
              onClick={() => activateTab(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) closeTab(tab.id);
              }}
              onKeyDown={(event) => renaming !== tab.id && onKeyDown(event, tab, index)}
              onContextMenu={(event) => {
                event.preventDefault();
                tabMenu(tab, event.clientX, event.clientY);
              }}
              onDoubleClick={() => tab.kind !== 'console' && setRenaming(tab.id)}
              whileDrag={{ zIndex: 2, opacity: 0.85 }}
            >
              <Icon name={tabIcon(tab)} className={styles.icon} />
              {renaming === tab.id ? (
                <input
                  className={styles.rename}
                  defaultValue={title}
                  aria-label="Tab name"
                  autoFocus
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    // Enter that confirms an input method's word does not end the rename.
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === 'Enter') event.currentTarget.blur();
                    else if (event.key === 'Escape') {
                      event.currentTarget.value = title;
                      event.currentTarget.blur();
                    }
                  }}
                  onBlur={(event) => {
                    const next = event.currentTarget.value.trim();
                    if (next && next !== title) updateTab(tab.id, { title: next });
                    setRenaming(undefined);
                  }}
                />
              ) : (
                <span className={styles.title}>{title}</span>
              )}
              {tabs.tabs.length > 1 ? (
                // A pointer shortcut only (a control inside a tab would be one screen readers and
                // the keyboard reach separately): Delete and the tab's menu close it too.
                <span
                  className={styles.close}
                  aria-hidden="true"
                  title={`Close ${title} (Delete)`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <Icon name="close" />
                </span>
              ) : null}
              {active ? (
                <motion.div
                  layoutId="lf-tab-indicator"
                  className={styles.indicator}
                  transition={INDICATOR_SPRING}
                />
              ) : null}
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
      <IconButton
        icon="add"
        label="New view"
        small
        className={styles.add}
        onClick={(event) => newTabMenu(event.currentTarget)}
      />
    </div>
  );
}
