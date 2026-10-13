/**
 * Repository statistics: what the Statistics view asks the host for and what it gets back. The
 * host reads and counts the commits; the webview only ever receives aggregates.
 */
import type { HeadInfo } from './models';

/** The history counted: the current branch (HEAD), or every branch, remote branch and tag. */
export type StatsScope = 'head' | 'all';
/** How far back: everything, or the last 12 months, 3 months or 30 days. */
export type StatsRange = 'all' | '12m' | '3m' | '30d';
/** Contributors by most commits, most lines changed, or most recent commit. */
export type ContributorSort = 'commits' | 'lines' | 'recent';
/** Hotspots per file, or per top-level folder. */
export type HotspotGroup = 'files' | 'folders';
/** What the activity chart shows per period. */
export type ActivityMeasure = 'commits' | 'lines';

export const STATS_SCOPES: readonly StatsScope[] = ['head', 'all'];
export const STATS_RANGES: readonly StatsRange[] = ['all', '12m', '3m', '30d'];
export const CONTRIBUTOR_SORTS: readonly ContributorSort[] = ['commits', 'lines', 'recent'];
export const HOTSPOT_GROUPS: readonly HotspotGroup[] = ['files', 'folders'];
export const ACTIVITY_MEASURES: readonly ActivityMeasure[] = ['commits', 'lines'];

/** The longest author filter accepted: a name, or an email in angle brackets. */
export const MAX_AUTHOR_LENGTH = 256;

/** What a Statistics tab shows; saved with the tab. */
export interface StatsConfig {
  readonly scope: StatsScope;
  readonly range: StatsRange;
  /** Only this contributor's commits: their name, or `<email>` for commits without a name. */
  readonly author?: string;
  readonly sort: ContributorSort;
  readonly hotspots: HotspotGroup;
  readonly activity: ActivityMeasure;
}

export const DEFAULT_STATS_CONFIG: StatsConfig = {
  scope: 'head',
  range: 'all',
  sort: 'commits',
  hotspots: 'files',
  activity: 'commits',
};

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** An author filter as the view sends it: a non-empty name or `<email>`, without control characters. */
export function isAuthorFilter(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_AUTHOR_LENGTH &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f]/.test(value)
  );
}

/**
 * Whether a saved config (from storage, maybe from another version) can be used: every field it
 * has is valid. Missing fields take their defaults (see {@link statsConfig}).
 */
export function isStatsConfig(value: unknown): value is Partial<StatsConfig> {
  if (!value || typeof value !== 'object') return false;
  const { scope, range, author, sort, hotspots, activity } = value as Record<string, unknown>;
  const optional = <T extends string>(values: readonly T[], field: unknown) =>
    field === undefined || isOneOf(values, field);
  return (
    optional(STATS_SCOPES, scope) &&
    optional(STATS_RANGES, range) &&
    optional(CONTRIBUTOR_SORTS, sort) &&
    optional(HOTSPOT_GROUPS, hotspots) &&
    optional(ACTIVITY_MEASURES, activity) &&
    (author === undefined || isAuthorFilter(author))
  );
}

/** A tab's config with the defaults for whatever it does not say. */
export function statsConfig(value: Partial<StatsConfig> | undefined): StatsConfig {
  return { ...DEFAULT_STATS_CONFIG, ...value };
}

/** What `stats.get` is asked for. */
export interface StatsQuery {
  readonly repoId: string;
  readonly scope: StatsScope;
  readonly range: StatsRange;
  readonly author?: string;
  readonly sort: ContributorSort;
  readonly hotspots: HotspotGroup;
  /** How many contributors and hotspots to list (all of them are counted). */
  readonly contributors: number;
  readonly files: number;
  /** The viewer's time zone (an IANA name): activity follows its calendar days. */
  readonly timeZone?: string;
  /**
   * Read the refs again (the repository changed, or a refresh was asked for). Without it, the
   * refs read last are used until the host sees a change: another order or filter runs no git.
   */
  readonly refresh?: boolean;
}

export interface StatsSummary {
  /** Commits, merges included. */
  readonly commits: number;
  readonly merges: number;
  readonly contributors: number;
  /** Lines added and removed by the commits whose lines are counted (see {@link LineCoverage}). */
  readonly added: number;
  readonly removed: number;
  /** Files changed by the commits whose lines are counted. */
  readonly files: number;
  /** Calendar days with at least one commit. */
  readonly activeDays: number;
  /** Author times (seconds since the epoch) of the first and the last commit. */
  readonly first?: number;
  readonly last?: number;
  /** Lines changed by the typical (median) commit whose lines are counted. */
  readonly medianLines?: number;
}

/** The length of the activity chart's periods: chosen so that there are about 20 to 80. */
export type ActivityUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface ActivityBucket {
  /** The period's first and last calendar day ("2024-03-01"), in the viewer's time zone. */
  readonly start: string;
  readonly end: string;
  readonly commits: number;
  readonly added: number;
  readonly removed: number;
}

export interface ActivitySeries {
  readonly unit: ActivityUnit;
  readonly buckets: readonly ActivityBucket[];
  /**
   * When lines are not counted for every commit: the first period (index) they are known for.
   * Earlier periods have no line counts. Undefined when every commit's lines are counted.
   */
  readonly linesFrom?: number;
}

export interface Contributor {
  /** What the view filters by: the name, or `<email>` when their commits have no name. */
  readonly author: string;
  /** Name and email of their latest commit. */
  readonly name: string;
  readonly email: string;
  /** Every email their commits use, the latest first (at most a few). */
  readonly emails: readonly string[];
  readonly commits: number;
  /** Their share of all the commits (0 to 1). */
  readonly share: number;
  readonly added: number;
  readonly removed: number;
  /** Author times of their first and last commit. */
  readonly first: number;
  readonly last: number;
  readonly activeDays: number;
}

/** The author the view is filtered to, as the header describes them. */
export interface AuthorProfile extends Contributor {
  /** Their busiest weekday (0 Monday … 6 Sunday), in their commits' own time zones. */
  readonly weekday?: number;
  /** Their busiest two hours: [10, 12] is 10:00–12:00, in their commits' own time zones. */
  readonly hours?: readonly [number, number];
}

export interface Hotspot {
  /** A file's path, or a top-level folder ('' for the files at the top level). */
  readonly path: string;
  /** Commits that changed it. */
  readonly commits: number;
  readonly added: number;
  readonly removed: number;
  /** Authors who changed it. */
  readonly authors: number;
}

/** Which commits' changed lines are counted (reading them is the slow part). */
export interface LineCoverage {
  /** Commits (merges aside: they add no lines of their own) whose lines are counted. */
  readonly counted: number;
  /** Commits (merges aside) shown. */
  readonly total: number;
  /** The newest commits of the scope counted at most. */
  readonly limit: number;
  /** The scope's lines are still being counted. */
  readonly pending: boolean;
}

export interface StatsResult {
  readonly head: HeadInfo;
  /** Commits in the scope: all time, every author. */
  readonly scopeCommits: number;
  readonly summary: StatsSummary;
  readonly activity: ActivitySeries;
  /** Every author with commits shown (`total`), the first few in the order asked for. */
  readonly contributors: { readonly total: number; readonly rows: readonly Contributor[] };
  /** The author filtered to (undefined without a filter, or when they have no commits here). */
  readonly author?: AuthorProfile;
  /** Commits per weekday (Monday first) and hour, in each commit's own time zone: 7 × 24 counts. */
  readonly punchCard: readonly number[];
  readonly hotspots: { readonly total: number; readonly rows: readonly Hotspot[] };
  readonly lines: LineCoverage;
}

/** How far the host is with a long read (broadcast while it runs). */
export interface StatsProgress {
  readonly repoId: string;
  readonly scope: StatsScope;
  /** 'commits': reading the history; 'lines': counting changed lines. */
  readonly phase: 'commits' | 'lines';
  readonly done: number;
  /** How many in all, when known. */
  readonly total?: number;
}

/** The outcome of `stats.countLines`. */
export interface LineCount {
  /** Commits whose lines are counted now, of the `target` newest. */
  readonly counted: number;
  readonly target: number;
  /** Commits this call read (the others were known already). */
  readonly computed: number;
}

export interface LanguageShare {
  /** "TypeScript", "Markdown"… or "Other". */
  readonly language: string;
  readonly files: number;
  readonly bytes: number;
}

/** What HEAD's files are, by language (the largest first, "Other" last). */
export interface LanguageStats {
  readonly languages: readonly LanguageShare[];
  readonly files: number;
  readonly bytes: number;
}

function plural(count: number, unit: string): string {
  return `${count.toLocaleString()} ${unit}${count === 1 ? '' : 's'}`;
}

/** The time from one date to another in words, in the local calendar: "2 years, 3 months". */
export function spanInWords(first: number, last: number): string {
  const a = new Date(Math.min(first, last) * 1000);
  const b = new Date(Math.max(first, last) * 1000);
  let months = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
  if (b.getDate() < a.getDate()) months -= 1;
  if (months >= 12) {
    const years = Math.floor(months / 12);
    const rest = months % 12;
    return rest > 0 ? `${plural(years, 'year')}, ${plural(rest, 'month')}` : plural(years, 'year');
  }
  if (months >= 1) return plural(months, 'month');
  const days = Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
      Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
      86_400_000,
  );
  return days === 0 ? 'a single day' : plural(days, 'day');
}

/** The log search for an author's commits: "@carol", `author:"Carol Chen"`, or "@carol@x.dev". */
export function authorSearch(author: string): string {
  const email = /^<([^<>\s]+)>$/.exec(author.trim())?.[1];
  if (email) return `@${email}`;
  const name = author.trim().replace(/"/g, '');
  return /^[^\s:]+$/.test(name) ? `@${name}` : `author:"${name}"`;
}

/** The log search for the commits of a period (calendar days, inclusive, in git's time zone). */
export function periodSearch(start: string, end: string): string {
  // A date alone would mean that day at the current time of day to git.
  return `after:"${start} 00:00:00" before:"${end} 23:59:59"`;
}
