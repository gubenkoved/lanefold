import { MotionConfig } from 'motion/react';
import { useEffect, useState } from 'react';
import type { HostCommand } from '../shared/protocol';
import { EmptyState } from './components/EmptyState';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/Icon';
import { MenuHost } from './components/Menu';
import { PickerHost } from './components/Picker';
import { ToastHost } from './components/Toast';
import { TopBar } from './components/TopBar';
import { useHost } from './hostContext';
import { isSharedTab } from './state/sharedTab';
import { useApp } from './state/store';
import { tabTitles } from './state/tabs';
import { CompareView } from './views/compare/CompareView';
import { ConsoleView } from './views/ConsoleView';
import { LogView } from './views/log/LogView';
import { OpBanner } from './views/ops/OpBanner';
import { OperationSheet } from './views/ops/OperationSheet';
import { ReflogView } from './views/reflog/ReflogView';
import { ReposLogView } from './views/repos/ReposLogView';
import { StashesView } from './views/stash/StashesView';
import { StatsView } from './views/stats/StatsView';
import styles from './App.module.css';

/** Mirrors the animation setting onto <html data-motion>, which scales every CSS duration. */
function useMotionLevel(): 'full' | 'reduced' | 'off' {
  const animations = useApp((state) => state.settings.animations);
  useEffect(() => {
    document.documentElement.dataset.motion = animations;
  }, [animations]);
  return animations;
}

/** Widths below which parts of the UI condense (see the `html[data-lt…]` rules in the styles). */
const WIDTH_STEPS = [640, 560, 440, 340];

/**
 * Marks <html> with the width steps the app is narrower than (`data-lt560`…), for styles that
 * adapt to a side bar. Container queries would do, but they make the app a containing block
 * for its fixed-position menus.
 */
function useWidthSteps(): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!element) return;
    const root = document.documentElement;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? element.clientWidth;
      if (width === 0) return;
      for (const step of WIDTH_STEPS) root.toggleAttribute(`data-lt${step}`, width < step);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return setElement;
}

/**
 * Titles an editor tab after the view it shows (the panel keeps its own name), and after its
 * repository when several are open.
 */
function useEditorTitle(): void {
  const host = useHost();
  const title = useApp((state) => {
    const tab = state.tabs.tabs.find((candidate) => candidate.id === state.tabs.activeTabId);
    if (!tab) return 'Lanefold';
    const branch = state.activeRepoId ? state.heads[state.activeRepoId]?.branch : undefined;
    const shown = tabTitles(state.tabs.tabs, branch).get(tab.id) ?? tab.title;
    const repo =
      state.repos.length > 1 && !isSharedTab(tab)
        ? state.repos.find((candidate) => candidate.id === state.activeRepoId)
        : undefined;
    return repo ? `${shown} · ${repo.name}` : shown;
  });
  useEffect(() => {
    if (host.kind === 'editor') host.rpc.emit('ui.title', { title });
  }, [host, title]);
}

/** Log and compare tabs stay mounted for a while after being left, so switching back is instant. */
const KEEP_ALIVE = 4;

function Views() {
  const tabs = useApp((state) => state.tabs);
  const repoId = useApp((state) => state.activeRepoId);
  const branch = useApp((state) =>
    state.activeRepoId ? state.heads[state.activeRepoId]?.branch : undefined,
  );
  // Right after switching repository the tabs are still the previous one's: wait for its own.
  const tabsReady = useApp((state) => state.tabsRepoId === state.activeRepoId);
  const [recent, setRecent] = useState<readonly string[]>([]);
  const activeId = tabs.activeTabId;
  // Most recently active first; derived during render so the active tab mounts immediately.
  if (recent[0] !== activeId)
    setRecent([activeId, ...recent.filter((id) => id !== activeId)].slice(0, KEEP_ALIVE));
  const mounted = new Set([activeId, ...recent]);
  if (!repoId) return null;
  const titles = tabTitles(tabs.tabs, branch);
  return (
    <>
      {tabs.tabs
        // While another repository's tabs load, only the tab they all share stays (hidden).
        .filter((tab) => mounted.has(tab.id) && (tabsReady || isSharedTab(tab)))
        .map((tab) => {
          const active = tabsReady && tab.id === activeId;
          let content;
          if (tab.kind === 'console') content = <ConsoleView />;
          else if (tab.kind === 'compare' && tab.compare)
            content = <CompareView tab={tab} repoId={repoId} active={active} />;
          else if (tab.kind === 'log' && tab.view)
            content = <LogView tab={tab} repoId={repoId} active={active} />;
          else if (tab.kind === 'stashes') content = <StashesView repoId={repoId} active={active} />;
          else if (tab.kind === 'reflog') content = <ReflogView repoId={repoId} active={active} />;
          else if (tab.kind === 'repos' && tab.view) content = <ReposLogView tab={tab} active={active} />;
          else if (tab.kind === 'stats') content = <StatsView tab={tab} repoId={repoId} active={active} />;
          return (
            <div
              // The shared tab is no repository's: it stays mounted when the repository changes.
              key={isSharedTab(tab) ? `shared:${tab.id}` : `${repoId}:${tab.id}`}
              className={styles.view}
              hidden={!active}
              role="tabpanel"
              aria-label={titles.get(tab.id) ?? tab.title}
            >
              <ErrorBoundary label="This view">{content}</ErrorBoundary>
            </div>
          );
        })}
    </>
  );
}

export function App() {
  const host = useHost();
  const phase = useApp((state) => state.phase);
  const error = useApp((state) => state.error);
  const gitError = useApp((state) => state.gitError);
  const repoCount = useApp((state) => state.repos.length);
  const motion = useMotionLevel();
  const widthRef = useWidthSteps();
  useEditorTitle();

  const action = (command: HostCommand, icon: string, label: string) => (
    <button
      type="button"
      className={styles.emptyAction}
      onClick={() => void host.rpc.call('host.command', { command }).catch(() => undefined)}
    >
      <Icon name={icon} /> {label}
    </button>
  );

  let content;
  if (phase === 'connecting') {
    content = (
      <div className={styles.connecting}>
        <Icon name="loading" spin /> Connecting…
      </div>
    );
  } else if (phase === 'error') {
    content = (
      <EmptyState
        icon="error"
        title="Lanefold could not start"
        description="Something went wrong while loading. The log has the details."
        detail={error}
        actions={action('showOutput', 'output', 'Show log')}
      />
    );
  } else if (gitError) {
    content = (
      <EmptyState
        icon="warning"
        title="Git was not found"
        description={
          <>
            Lanefold works with the git installed on this machine. Install git, or set{' '}
            <code>lanefold.git.path</code> to where it is.
          </>
        }
        detail={gitError}
        actions={
          <>
            {action('openSettings', 'settings-gear', 'Open settings')}
            {action('showOutput', 'output', 'Show log')}
          </>
        }
      />
    );
  } else if (repoCount === 0) {
    content = (
      <EmptyState
        title="No repository"
        description="Open a folder that contains a git repository, or start one: Lanefold shows its history here."
        actions={
          <>
            {action('openFolder', 'folder-opened', 'Open folder…')}
            {action('clone', 'repo-clone', 'Clone…')}
            {action('init', 'repo', 'Initialize…')}
          </>
        }
      />
    );
  }

  return (
    <MotionConfig reducedMotion={motion === 'full' ? 'user' : 'always'}>
      <div className={styles.app} data-host={host.kind} ref={widthRef}>
        {content ? (
          <main className={styles.main}>{content}</main>
        ) : (
          <>
            <TopBar />
            <OpBanner />
            <main className={styles.main}>
              <Views />
            </main>
          </>
        )}
        <MenuHost />
        <PickerHost />
        <OperationSheet />
        <ToastHost />
      </div>
    </MotionConfig>
  );
}
