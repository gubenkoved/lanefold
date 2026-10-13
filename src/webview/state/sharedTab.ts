import { CONSOLE_TAB_ID, restoreTabs, type TabModel, type TabsState } from './tabs';

/**
 * The tab every repository shows: "All repositories" (a log of every repository belongs to none
 * of them). What it shows (title, scope, repositories left out) is saved apart from the
 * repositories' own tabs and is the same in each; each repository keeps where it sits among its
 * tabs. Closing it, in any repository, closes it everywhere.
 */
let shared: TabModel | undefined;

/** Where the shared tab is saved (the webview's storage). */
export const SHARED_TAB_KEY = 'tabs:shared';

/** Whether a tab is the shared one's kind. */
export function isSharedTab(tab: TabModel): boolean {
  return tab.kind === 'repos';
}

/** The shared tab now (undefined: there is none). */
export function sharedTab(): TabModel | undefined {
  return shared;
}

/** Takes the stored shared tab (at startup). Anything that is not a valid one means none. */
export function adoptSharedTab(value: unknown): void {
  const id = (value as { id?: unknown } | null | undefined)?.id;
  const tab = typeof id === 'string' ? restoreTabs({ tabs: [value], activeTabId: id })?.tabs[0] : undefined;
  shared = tab && isSharedTab(tab) ? tab : undefined;
}

/**
 * A repository's tabs with the shared tab among them: where this repository had it, else before
 * the Console. Copies of a shared tab closed (or replaced) meanwhile are left out.
 */
export function withSharedTab(state: TabsState): TabsState {
  const own = state.tabs.filter((tab) => !isSharedTab(tab) || tab.id === shared?.id);
  let tabs = own;
  if (shared) {
    const current = shared;
    if (own.some((tab) => tab.id === current.id))
      tabs = own.map((tab) => (tab.id === current.id ? current : tab));
    else {
      const consoleIndex = own.findIndex((tab) => tab.id === CONSOLE_TAB_ID);
      tabs = [...own];
      tabs.splice(consoleIndex < 0 ? tabs.length : consoleIndex, 0, current);
    }
  }
  if (tabs.length === 0) return state;
  const activeTabId = tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : tabs[0]!.id;
  return { tabs, activeTabId };
}

/**
 * Notes what became of the shared tab in the active repository's tabs (added, changed, closed);
 * `save` stores the change (null once it is closed).
 */
export function noteSharedTab(state: TabsState, save: (tab: TabModel | null) => void): void {
  const tab = state.tabs.find(isSharedTab);
  if (tab === shared) return;
  shared = tab;
  save(tab ?? null);
}
