import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  isLineRange,
  type ConsoleEntry,
  type GitInfo,
  type HeadInfo,
  type RefScope,
  type RepoSummary,
  type Settings,
} from '../../shared/models';
import { errorText } from '../bridge/errorText';
import type { HostConnection } from '../bridge/host';
import { mark } from '../perf';
import { requestReveal } from './reveal';
import { adoptSharedTab, noteSharedTab, SHARED_TAB_KEY, withSharedTab } from './sharedTab';
import {
  CONSOLE_TAB_ID,
  consoleTab,
  defaultTabs,
  newTabId,
  restoreTabs,
  type TabModel,
  type TabsState,
} from './tabs';
import { focusWhenShown } from './viewFocus';

const MAX_CONSOLE_ENTRIES = 1000;

/** Window event asking every view to reload (toolbar button, `lanefold.refresh` command). */
export const REFRESH_EVENT = 'lanefold:refresh';

/** A file's, folder's or lines' history in a new tab (asked for by the host). */
function openHistoryFromHost(command: string, args: unknown): void {
  const { repoId, path, start, end, rev } = (args ?? {}) as Record<string, unknown>;
  if (typeof repoId !== 'string' || repoId !== useApp.getState().activeRepoId) return;
  if (typeof path !== 'string' || (rev !== undefined && typeof rev !== 'string')) return;
  const scope: RefScope = rev ? { type: 'refs', refs: [rev] } : { type: 'head' };
  const name = path.slice(path.lastIndexOf('/') + 1) || 'Repository';
  if (command === 'openFileHistory') {
    useApp.getState().addTab({ kind: 'log', title: name, view: { scope, paths: path ? [path] : undefined } });
    return;
  }
  const lines = { path, start, end };
  if (!isLineRange(lines)) return;
  useApp.getState().addTab({
    kind: 'log',
    title: lines.start === lines.end ? `${name}:${lines.start}` : `${name}:${lines.start}–${lines.end}`,
    view: { scope, lines },
  });
}

/** Shows a commit in a log tab: the active one, else the first one, else a new "All" tab. */
export function showInLog(repoId: string, sha: string): void {
  const { tabs, activateTab, addTab } = useApp.getState();
  const active = tabs.tabs.find((tab) => tab.id === tabs.activeTabId);
  if (active?.kind !== 'log') {
    const log = tabs.tabs.find((tab) => tab.kind === 'log');
    if (log) activateTab(log.id);
    // Without one the reveal would wait, then happen whenever a log tab next opens.
    else addTab({ kind: 'log', title: 'All', view: { scope: { type: 'all' } } });
  }
  requestReveal(repoId, sha);
}

/** Activates the Stashes tab, opening one if there is none; its list takes keyboard focus. */
export function showStashes(): void {
  focusWhenShown('stashes');
  const { tabs, activateTab, addTab } = useApp.getState();
  const existing = tabs.tabs.find((tab) => tab.kind === 'stashes');
  if (existing) activateTab(existing.id);
  else addTab({ kind: 'stashes', title: 'Stashes' });
}

/** The host connection, for components outside the React tree (graph engine, menus). */
export function hostRpc(): HostConnection['rpc'] {
  if (!host) throw new Error('Not connected');
  return host.rpc;
}

export interface AppStore {
  readonly phase: 'connecting' | 'ready' | 'error';
  readonly error?: string;
  readonly git?: GitInfo;
  readonly gitError?: string;
  readonly repos: readonly RepoSummary[];
  readonly activeRepoId?: string;
  readonly settings: Settings;
  readonly heads: Readonly<Record<string, HeadInfo>>;
  readonly consoleEntries: readonly ConsoleEntry[];
  readonly tabs: TabsState;
  /** The repository `tabs` belong to (after a switch, until its own tabs are loaded, another). */
  readonly tabsRepoId?: string;

  selectRepo(repoId: string): void;
  activateTab(tabId: string): void;
  closeTab(tabId: string): void;
  addTab(tab: Omit<TabModel, 'id'>): void;
  /** Changes a tab in place (its view options, comparison or title). */
  updateTab(tabId: string, patch: Partial<Omit<TabModel, 'id' | 'kind'>>): void;
  moveTab(tabId: string, toIndex: number): void;
  setTabOrder(order: readonly TabModel[]): void;
  showConsole(): void;
  /** Activates the Statistics tab (there is one at most), opening it if there is none. */
  showStatistics(): void;
  clearConsole(): void;
}

let host: HostConnection | undefined;

function persistTabs(repoId: string | undefined, tabs: TabsState): void {
  if (!host || !repoId) return;
  void host.rpc.call('storage.set', { key: `tabs:${repoId}`, value: tabs }).catch(() => undefined);
}

export const useApp = create<AppStore>()((set, get) => {
  const updateTabs = (next: TabsState) => {
    set({ tabs: next });
    persistTabs(get().tabsRepoId, next);
    // The tab every repository shows is saved apart, for all of them.
    noteSharedTab(next, (tab) => {
      void host?.rpc.call('storage.set', { key: SHARED_TAB_KEY, value: tab }).catch(() => undefined);
    });
  };

  return {
    phase: 'connecting',
    repos: [],
    settings: DEFAULT_SETTINGS,
    heads: {},
    consoleEntries: [],
    tabs: defaultTabs(DEFAULT_SETTINGS.defaultTabs),

    selectRepo(repoId) {
      void host?.rpc.call('repo.select', { repoId });
    },

    activateTab(tabId) {
      const { tabs } = get();
      if (tabs.activeTabId !== tabId && tabs.tabs.some((tab) => tab.id === tabId)) {
        updateTabs({ ...tabs, activeTabId: tabId });
      }
    },

    closeTab(tabId) {
      const { tabs } = get();
      const index = tabs.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0 || tabs.tabs.length === 1) return;
      const remaining = tabs.tabs.filter((tab) => tab.id !== tabId);
      const activeTabId =
        tabs.activeTabId === tabId ? remaining[Math.min(index, remaining.length - 1)]!.id : tabs.activeTabId;
      updateTabs({ tabs: remaining, activeTabId });
    },

    addTab(tab) {
      const { tabs } = get();
      const created: TabModel = { ...tab, id: newTabId() };
      const consoleIndex = tabs.tabs.findIndex((t) => t.id === CONSOLE_TAB_ID);
      const list = [...tabs.tabs];
      list.splice(consoleIndex < 0 ? list.length : consoleIndex, 0, created);
      updateTabs({ tabs: list, activeTabId: created.id });
    },

    updateTab(tabId, patch) {
      const { tabs } = get();
      if (!tabs.tabs.some((tab) => tab.id === tabId)) return;
      updateTabs({
        ...tabs,
        tabs: tabs.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
      });
    },

    moveTab(tabId, toIndex) {
      const { tabs } = get();
      const from = tabs.tabs.findIndex((tab) => tab.id === tabId);
      if (from < 0) return;
      const list = [...tabs.tabs];
      const [moved] = list.splice(from, 1);
      list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, moved!);
      updateTabs({ ...tabs, tabs: list });
    },

    setTabOrder(order) {
      const { tabs } = get();
      const ids = new Set(tabs.tabs.map((tab) => tab.id));
      if (order.length !== ids.size || !order.every((tab) => ids.has(tab.id))) return;
      updateTabs({ ...tabs, tabs: order });
    },

    showConsole() {
      const { tabs } = get();
      if (tabs.tabs.some((tab) => tab.id === CONSOLE_TAB_ID))
        updateTabs({ ...tabs, activeTabId: CONSOLE_TAB_ID });
      else updateTabs({ tabs: [...tabs.tabs, consoleTab()], activeTabId: CONSOLE_TAB_ID });
    },

    showStatistics() {
      const { tabs, activateTab, addTab } = get();
      const existing = tabs.tabs.find((tab) => tab.kind === 'stats');
      if (existing) activateTab(existing.id);
      else addTab({ kind: 'stats', title: 'Statistics' });
    },

    clearConsole() {
      set({ consoleEntries: [] });
      void host?.rpc.call('console.clear');
    },
  };
});

/** Settles once the active repository's tabs are loaded (host commands wait for it). */
let tabsReady: Promise<void> = Promise.resolve();

/** Settles once the active repository's tabs are loaded: after a switch, the new one's. */
export function tabsLoaded(): Promise<void> {
  return tabsReady;
}

async function loadTabs(repoId: string | undefined): Promise<void> {
  const { settings } = useApp.getState();
  const stored =
    host && repoId
      ? await host.rpc.call('storage.get', { key: `tabs:${repoId}` }).catch(() => undefined)
      : undefined;
  // A quicker switch to yet another repository made these tabs moot.
  if (useApp.getState().activeRepoId !== repoId) return;
  useApp.setState({
    tabs: withSharedTab(restoreTabs(stored) ?? defaultTabs(settings.defaultTabs)),
    tabsRepoId: repoId,
  });
}

async function refreshHead(repoId: string): Promise<void> {
  if (!host) return;
  try {
    const { head } = await host.rpc.call('repo.state', { repoId });
    useApp.setState((state) => ({ heads: { ...state.heads, [repoId]: head } }));
  } catch {
    // The repository may have been closed meanwhile.
  }
}

function upsertConsole(entry: ConsoleEntry): void {
  useApp.setState((state) => {
    const entries = state.consoleEntries;
    const index = entries.findIndex((existing) => existing.id === entry.id);
    let next: ConsoleEntry[];
    if (index >= 0) {
      next = entries.slice();
      next[index] = entry;
    } else {
      next =
        entries.length >= MAX_CONSOLE_ENTRIES
          ? entries.slice(entries.length - MAX_CONSOLE_ENTRIES + 1)
          : entries.slice();
      next.push(entry);
    }
    return { consoleEntries: next };
  });
}

/** Connects the store to the host: initial load plus live events. */
export async function connectStore(connection: HostConnection): Promise<void> {
  host = connection;
  const { rpc } = connection;

  rpc.on('repos.changed', ({ repos, activeRepoId }) => {
    const previous = useApp.getState().activeRepoId;
    useApp.setState({ repos, activeRepoId });
    if (activeRepoId && activeRepoId !== previous) {
      tabsReady = loadTabs(activeRepoId);
      void refreshHead(activeRepoId);
    }
  });
  rpc.on('repo.changed', ({ repoId, kinds }) => {
    if (kinds.includes('head') || kinds.includes('refs')) void refreshHead(repoId);
  });
  rpc.on('console.entry', upsertConsole);
  rpc.on('settings.changed', (settings) => useApp.setState({ settings }));
  rpc.on('command.run', ({ command, args }) => {
    if (command === 'showConsole') useApp.getState().showConsole();
    else if (command === 'showStatistics') void tabsReady.then(() => useApp.getState().showStatistics());
    else if (command === 'refresh') window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
    else if (command === 'revealCommit') {
      const { repoId, sha } = (args ?? {}) as { repoId?: string; sha?: string };
      if (typeof repoId !== 'string' || typeof sha !== 'string') return;
      void tabsReady.then(() => showInLog(repoId, sha));
    } else if (command === 'openFileHistory' || command === 'openLineHistory') {
      void tabsReady.then(() => openHistoryFromHost(command, args));
    }
  });
  rpc.on('app.resync', () => void initialize());

  async function initialize(): Promise<void> {
    mark('init');
    try {
      const [init, history, shared] = await Promise.all([
        rpc.call('app.init'),
        rpc.call('console.history'),
        rpc.call('storage.get', { key: SHARED_TAB_KEY }).catch(() => undefined),
      ]);
      if (init.activeRepoId) void refreshHead(init.activeRepoId);
      adoptSharedTab(shared);
      // Views mount once, with the restored tabs (mounting the defaults first would start a
      // log load that is thrown away a moment later).
      const tabs = withSharedTab(restoreTabs(init.tabs) ?? defaultTabs(init.settings.defaultTabs));
      useApp.setState({
        phase: 'ready',
        git: init.git,
        gitError: init.gitError,
        repos: init.repos,
        activeRepoId: init.activeRepoId,
        settings: init.settings,
        consoleEntries: history.slice(-MAX_CONSOLE_ENTRIES),
        tabs,
        tabsRepoId: init.activeRepoId,
      });
      mark('ready');
    } catch (error) {
      useApp.setState({ phase: 'error', error: errorText(error) });
    }
  }

  await initialize();
}
