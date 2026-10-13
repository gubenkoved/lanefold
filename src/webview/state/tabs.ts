import {
  isLineRange,
  parseRefScope,
  type DefaultTabTemplate,
  type RefScope,
  type ViewConfig,
} from '../../shared/models';
import { isStatsConfig, type StatsConfig } from '../../shared/stats';

/** 'repos': the history of every open repository together ("All repositories"). */
export type TabKind = 'log' | 'compare' | 'console' | 'stashes' | 'reflog' | 'repos' | 'stats';

export type CompareMode = 'three-dot' | 'two-dot';

/** What a compare tab compares: two revisions (ref names or commit hashes). */
export interface CompareConfig {
  readonly a: string;
  readonly b: string;
  readonly mode: CompareMode;
}

export interface TabModel {
  readonly id: string;
  readonly kind: TabKind;
  readonly title: string;
  /** Log tabs only. */
  readonly view?: ViewConfig;
  /** Compare tabs only. */
  readonly compare?: CompareConfig;
  /** "All repositories" tabs only: the repositories left out (ids). */
  readonly hiddenRepos?: readonly string[];
  /** Statistics tabs only: what they show (defaults for what is not said). */
  readonly stats?: Partial<StatsConfig>;
  /** Log tabs only: the search the tab opened with (an author's commits); kept until cleared. */
  readonly search?: string;
}

export interface TabsState {
  readonly tabs: readonly TabModel[];
  readonly activeTabId: string;
}

let counter = 0;
export function newTabId(): string {
  counter += 1;
  return `t${Date.now().toString(36)}${counter.toString(36)}`;
}

export const CONSOLE_TAB_ID = 'console';

export function consoleTab(): TabModel {
  return { id: CONSOLE_TAB_ID, kind: 'console', title: 'Console' };
}

export function defaultTabs(templates: readonly DefaultTabTemplate[]): TabsState {
  const tabs: TabModel[] = templates.map((template) => ({
    id: newTabId(),
    kind: 'log',
    title: template.name,
    view: { scope: parseRefScope(template.refs) },
  }));
  tabs.push(consoleTab());
  return { tabs, activeTabId: tabs[0]!.id };
}

/** The automatic title of a current-branch view (what the scope is called until renamed). */
export const HEAD_TITLE = 'HEAD';

/**
 * What a tab is called on screen: a current-branch view still titled automatically is named
 * after the branch checked out ("HEAD" while detached), every other tab after its title.
 */
export function tabTitle(tab: TabModel, branch: string | undefined): string {
  return tab.kind === 'log' && tab.view?.scope.type === 'head' && tab.title === HEAD_TITLE
    ? (branch ?? HEAD_TITLE)
    : tab.title;
}

/**
 * Each tab's title on screen, no two alike: a later tab of the same name is numbered ("All 2"),
 * with a number no other tab is called by.
 */
export function tabTitles(
  tabs: readonly TabModel[],
  branch: string | undefined,
): ReadonlyMap<string, string> {
  const names = tabs.map((tab) => tabTitle(tab, branch));
  const given = new Set(names);
  const taken = new Set<string>();
  const titles = new Map<string, string>();
  tabs.forEach((tab, index) => {
    const name = names[index]!;
    let title = name;
    for (let n = 2; taken.has(title) || (title !== name && given.has(title)); n++) title = `${name} ${n}`;
    taken.add(title);
    titles.set(tab.id, title);
  });
  return titles;
}

function sameScope(a: RefScope, b: RefScope): boolean {
  if (a.type !== 'refs' || b.type !== 'refs') return a.type === b.type;
  return a.refs.length === b.refs.length && a.refs.every((ref, index) => ref === b.refs[index]);
}

/** The log tab that shows a scope as it comes (no branches hidden, no paths, no search), if any. */
export function plainLogTab(tabs: readonly TabModel[], scope: RefScope): TabModel | undefined {
  return tabs.find(
    (tab) =>
      tab.kind === 'log' &&
      !!tab.view &&
      sameScope(tab.view.scope, scope) &&
      !tab.view.hidden?.length &&
      !tab.view.paths?.length &&
      !tab.view.lines &&
      !tab.search,
  );
}

/** Short display form of a revision: branch names as they are, hashes abbreviated. */
export function revLabel(rev: string): string {
  return /^[0-9a-f]{40,64}$/i.test(rev) ? rev.slice(0, 8) : rev;
}

/** "main ↔ feature", or "Compare" until both sides are chosen. */
export function compareTitle(config: CompareConfig): string {
  if (!config.a || !config.b) return 'Compare';
  return `${revLabel(config.a)} ↔ ${revLabel(config.b)}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validView(view: unknown): view is ViewConfig {
  if (!view || typeof view !== 'object') return false;
  const { hidden, paths, lines } = view as { hidden?: unknown; paths?: unknown; lines?: unknown };
  if (hidden !== undefined && !isStringArray(hidden)) return false;
  if (paths !== undefined && !isStringArray(paths)) return false;
  if (lines !== undefined && !isLineRange(lines)) return false;
  const scope = (view as ViewConfig).scope as unknown;
  if (!scope || typeof scope !== 'object') return false;
  const type = (scope as { type?: unknown }).type;
  if (type === 'refs') return isStringArray((scope as { refs?: unknown }).refs);
  return type === 'all' || type === 'head' || type === 'local';
}

/** A view of several repositories: their whole, local or current branches (no paths or names). */
function validReposView(view: unknown): view is ViewConfig {
  const type = validView(view) ? view.scope.type : undefined;
  return type === 'all' || type === 'local' || type === 'head';
}

/** The longest search a log tab keeps. */
const MAX_TAB_SEARCH = 1000;

function validSearch(search: unknown): boolean {
  return search === undefined || (typeof search === 'string' && search.length <= MAX_TAB_SEARCH);
}

function validCompare(compare: unknown): compare is CompareConfig {
  if (!compare || typeof compare !== 'object') return false;
  const { a, b, mode } = compare as Partial<CompareConfig>;
  return typeof a === 'string' && typeof b === 'string' && (mode === 'three-dot' || mode === 'two-dot');
}

/** Validates persisted tabs (they come from storage and may be from an older version). */
export function restoreTabs(value: unknown): TabsState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { tabs, activeTabId } = value as Partial<TabsState>;
  if (!Array.isArray(tabs) || tabs.length === 0 || typeof activeTabId !== 'string') return undefined;
  const valid = tabs.filter(
    (tab): tab is TabModel =>
      !!tab &&
      typeof tab.id === 'string' &&
      typeof tab.title === 'string' &&
      ((tab.kind === 'log' && validView(tab.view) && validSearch(tab.search)) ||
        (tab.kind === 'compare' && validCompare(tab.compare)) ||
        (tab.kind === 'repos' &&
          validReposView(tab.view) &&
          (tab.hiddenRepos === undefined || isStringArray(tab.hiddenRepos))) ||
        tab.kind === 'console' ||
        tab.kind === 'stashes' ||
        tab.kind === 'reflog' ||
        (tab.kind === 'stats' && (tab.stats === undefined || isStatsConfig(tab.stats)))),
  );
  if (valid.length === 0) return undefined;
  return {
    tabs: valid,
    activeTabId: valid.some((tab) => tab.id === activeTabId) ? activeTabId : valid[0]!.id,
  };
}
