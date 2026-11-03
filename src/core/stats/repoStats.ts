import type { HeadInfo } from '../../shared/models';
import { isObjectId } from '../../shared/oid';
import {
  CONTRIBUTOR_SORTS,
  HOTSPOT_GROUPS,
  isAuthorFilter,
  isOneOf,
  LINE_COUNTINGS,
  STATS_RANGES,
  STATS_SCOPES,
  type LanguageStats,
  type LineCount,
  type LineCounting,
  type StatsProgress,
  type StatsQuery,
  type StatsResult,
  type StatsScope,
} from '../../shared/stats';
import { revisions } from '../git/args';
import { GitError } from '../git/errors';
import type { Repository } from '../repo/repository';
import {
  aggregateStats,
  countCommits,
  prepareScope,
  type CommitTotals,
  type PreparedScope,
} from './aggregate';
import { ZoneCalendar } from './calendar';
import { parseTree, summarizeLanguages } from './languages';
import { StatsLogParser } from './parse';
import { CommitStore, LineStore } from './store';

/**
 * Line counts are read for at most this many of a scope's newest commits (merges aside), unless
 * all of them are asked for.
 */
export const LINE_LIMIT = 20_000;

/** The metadata read: hash, parents, mailmapped author name and email, `--date=raw` author date. */
const META_FORMAT = '--format=%x1e%H%x00%P%x00%aN%x00%aE%x00%ad';
const META_FIELDS = 4;
/** Progress is reported at most this often (ms). */
const PROGRESS_EVERY = 250;

function cancelled(): GitError {
  return new GitError([], null, 'Cancelled', '', { kind: 'cancelled', files: [] });
}

function isCancelled(error: unknown): boolean {
  return error instanceof GitError && error.kind === 'cancelled';
}

/**
 * Work several callers may wait for: it runs once, and is stopped when every caller has stopped
 * waiting before it is done (each waits with its own signal: a view that closed, a request that
 * was replaced).
 */
class SharedTask<T> {
  private readonly controller = new AbortController();
  private waiting = 0;
  private settled = false;
  readonly promise: Promise<T>;

  constructor(run: (signal: AbortSignal) => Promise<T>) {
    this.promise = run(this.controller.signal);
    const settle = () => {
      this.settled = true;
    };
    // Callers get the outcome through `join`; nobody waiting is not an unhandled rejection.
    this.promise.then(settle, settle);
  }

  /** It was stopped: a new caller must start it again. */
  get stopped(): boolean {
    return this.controller.signal.aborted;
  }

  join(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(cancelled());
    this.waiting++;
    return new Promise<T>((resolve, reject) => {
      let left = false;
      const leave = (): boolean => {
        if (left) return false;
        left = true;
        signal?.removeEventListener('abort', onAbort);
        if (--this.waiting === 0 && !this.settled) this.controller.abort();
        return true;
      };
      const onAbort = () => {
        if (leave()) reject(cancelled());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.promise.then(
        (value) => {
          if (leave()) resolve(value);
        },
        (error: unknown) => {
          if (leave()) reject(error);
        },
      );
    });
  }
}

/** A scope's commits as last read: from which tips, and every commit's number, newest first. */
interface ScopeState {
  readonly tips: readonly string[];
  readonly ids: Int32Array;
}

interface ScopeTips {
  readonly tips: readonly string[];
  readonly head: HeadInfo;
}

function sameTips(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tip, index) => tip === b[index]);
}

/** A list of numbers that grows as commits stream in. */
class IdList {
  private data = new Int32Array(4096);
  length = 0;
  push(value: number): void {
    if (this.length === this.data.length) {
      const grown = new Int32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = value;
  }
  take(): Int32Array {
    return this.data.slice(0, this.length);
  }
}

export interface RepoStatsOptions {
  /** The newest commits (merges aside) whose lines are counted, unless all are asked for. */
  readonly lineLimit?: number;
  /** Long reads say how far they are. */
  readonly onProgress?: (progress: Omit<StatsProgress, 'repoId'>) => void;
  /**
   * How long (ms) the refs read for a scope are trusted without asking git again, unless
   * {@link RepoStats.changed} says the repository changed or a request asks to refresh. 0 (the
   * default): never.
   */
  readonly tipsMaxAge?: number;
  /** Now, in seconds (tests). */
  readonly now?: () => number;
}

/** A validated `stats.get` request (see {@link checkStatsQuery}). */
export type CheckedQuery = Omit<StatsQuery, 'repoId'>;

/**
 * The statistics of one repository. Commits are read once and kept (they never change): when
 * the refs move, only the commits new to a scope are read (`git log <tips> --not <old tips>`).
 * Line counts (`--numstat`, the slow part) are read for the newest commits of a scope (or all of
 * them, when asked), in a job of their own that reports progress and stops when nobody waits for
 * it any more.
 */
export class RepoStats {
  private readonly commits: CommitStore;
  private readonly lines = new LineStore();
  private readonly lineLimit: number;
  private readonly scopes = new Map<StatsScope, ScopeState>();
  private readonly updates = new Map<StatsScope, { tips: readonly string[]; task: SharedTask<ScopeState> }>();
  /** Line counting jobs, by scope and window (see {@link window}). */
  private readonly counting = new Map<string, SharedTask<number>>();
  private readonly prepared = new Map<
    StatsScope,
    { ids: Int32Array; zone: string; window: number; scope: PreparedScope }
  >();
  /** The line window last asked for, per scope: what keeping line counts keeps. */
  private readonly windows = new Map<StatsScope, number>();
  private readonly calendars = new Map<string, ZoneCalendar>();
  private readonly tipsCache = new Map<StatsScope, { at: number; value: ScopeTips }>();
  /** The last commit totals counted (the slow part of a request), with what they are for. */
  private readonly totals: { scope: PreparedScope; key: string; value: CommitTotals }[] = [];
  private languageCache: { sha: string; stats: LanguageStats } | undefined;
  /** When it was last asked for something (idle caches are dropped). */
  lastUsed = Date.now();

  constructor(
    readonly repo: Repository,
    private readonly options: RepoStatsOptions = {},
  ) {
    this.commits = new CommitStore(repo.objectFormat === 'sha256' ? 32 : 20);
    this.lineLimit = options.lineLimit ?? LINE_LIMIT;
  }

  /** A read is running (the cache is not dropped meanwhile). */
  get busy(): boolean {
    return this.updates.size > 0 || this.counting.size > 0;
  }

  /** The repository changed: its refs are read again next time. */
  changed(): void {
    this.tipsCache.clear();
  }

  /** The statistics of a scope, from the commits read so far plus any new ones. */
  async get(query: CheckedQuery, signal?: AbortSignal): Promise<StatsResult> {
    this.lastUsed = Date.now();
    if (query.refresh) this.tipsCache.delete(query.scope);
    const window = this.window(query.scope, query.lines);
    const { state, head } = await this.scope(query.scope, signal);
    const calendar = this.calendar(query.timeZone);
    const scope = this.prepare(query.scope, state, calendar, window);
    const now = this.options.now?.() ?? Date.now() / 1000;
    const input = {
      commits: this.commits,
      lines: this.lines,
      scope,
      calendar,
      lineLimit: this.lineLimit,
      allLines: query.lines === 'all',
    };
    // Counting every commit again is needless while only lines, order or rows change.
    const key = JSON.stringify([query.range, query.author ?? null, calendar.dayOf(now)]);
    let totals = this.totals.find((entry) => entry.scope === scope && entry.key === key)?.value;
    if (!totals) {
      totals = countCommits(input, query.range, query.author, now);
      this.totals.unshift({ scope, key, value: totals });
      this.totals.length = Math.min(this.totals.length, 4);
    }
    return { head, ...aggregateStats(input, { ...query, now }, totals) };
  }

  /**
   * Reads the changed lines of the scope's newest commits (`lines: 'all'`: of all its commits)
   * that are not known yet, newest first, reporting progress. Resolves once they are all known;
   * stops early (keeping what it read) when `signal` aborts and nobody else waits.
   */
  async countLines(
    scope: StatsScope,
    signal?: AbortSignal,
    refresh = false,
    lines?: LineCounting,
  ): Promise<LineCount> {
    this.lastUsed = Date.now();
    if (refresh) this.tipsCache.delete(scope);
    const window = this.window(scope, lines);
    // A job per window: going back to the newest commits leaves the job counting all of them,
    // which stops once nobody waits for it.
    const key = `${scope}:${window}`;
    let computed = 0;
    // Commits made meanwhile may need counting too: go again (a few times at most).
    for (let round = 0; ; round++) {
      const { state } = await this.scope(scope, signal);
      const target = this.target(state, window);
      const missing = target.filter((id) => !this.lines.has(id));
      if (missing.length === 0 || round >= 3) {
        return { counted: target.length - missing.length, target: target.length, computed };
      }
      let task = this.counting.get(key);
      if (!task || task.stopped) {
        const job = new SharedTask((jobSignal) => this.readLines(scope, missing, target.length, jobSignal));
        this.counting.set(key, job);
        const forget = () => {
          if (this.counting.get(key) === job) this.counting.delete(key);
        };
        job.promise.then(forget, forget);
        task = job;
      }
      computed += await task.join(signal);
    }
  }

  /** What HEAD's files are written in (remembered per commit). */
  async languages(signal?: AbortSignal): Promise<LanguageStats> {
    this.lastUsed = Date.now();
    const head = await this.repo.head();
    if (!head.sha) return { languages: [], files: 0, bytes: 0 };
    if (this.languageCache?.sha === head.sha) return this.languageCache.stats;
    const { stdout } = await this.repo.git(
      ['ls-tree', '-r', '-l', '-z', '--full-tree', ...revisions(head.sha)],
      {
        readOnly: true,
        background: true,
        label: 'Statistics: languages',
        signal,
      },
    );
    const stats = summarizeLanguages(parseTree(stdout));
    this.languageCache = { sha: head.sha, stats };
    return stats;
  }

  /**
   * How many of a scope's newest commits have their lines counted (Infinity: all of them), as a
   * request asks; remembered as the scope's window.
   */
  private window(scope: StatsScope, lines: LineCounting | undefined): number {
    const window = lines === 'all' ? Infinity : this.lineLimit;
    this.windows.set(scope, window);
    return window;
  }

  /** The scope's newest commits whose lines are counted (merges aside), as many as `window`. */
  private target(state: ScopeState, window: number): number[] {
    const target: number[] = [];
    for (let i = 0; i < state.ids.length && target.length < window; i++) {
      const id = state.ids[i]!;
      if (!this.commits.isMerge(id)) target.push(id);
    }
    return target;
  }

  private calendar(timeZone: string | undefined): ZoneCalendar {
    const key = timeZone ?? '';
    let calendar = this.calendars.get(key);
    if (!calendar) {
      if (this.calendars.size > 8) this.calendars.clear();
      calendar = new ZoneCalendar(timeZone);
      this.calendars.set(key, calendar);
    }
    return calendar;
  }

  private prepare(
    name: StatsScope,
    state: ScopeState,
    calendar: ZoneCalendar,
    window: number,
  ): PreparedScope {
    const cached = this.prepared.get(name);
    if (cached?.ids === state.ids && cached.zone === calendar.timeZone && cached.window === window)
      return cached.scope;
    const scope = prepareScope(this.commits, state.ids, calendar, window);
    this.prepared.set(name, { ids: state.ids, zone: calendar.timeZone, window, scope });
    return scope;
  }

  /**
   * Where a scope starts: HEAD, or HEAD and every branch, remote branch and tag. Ref targets as
   * they are (an annotated tag's own object: git peels it), so no object needs reading.
   */
  private async tips(name: StatsScope): Promise<ScopeTips> {
    const maxAge = this.options.tipsMaxAge ?? 0;
    const cached = this.tipsCache.get(name);
    if (cached && Date.now() - cached.at < maxAge) return cached.value;
    const options = { readOnly: true, background: true, label: 'Statistics: refs' } as const;
    const [head, refs] = await Promise.all([
      this.repo.head(),
      name === 'all'
        ? this.repo.git(
            ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags'],
            options,
          )
        : undefined,
    ]);
    const tips = new Set<string>();
    if (head.sha) tips.add(head.sha);
    for (const line of refs?.stdout.split('\n') ?? []) if (isObjectId(line)) tips.add(line);
    const value = { tips: [...tips].sort(), head };
    if (maxAge > 0) this.tipsCache.set(name, { at: Date.now(), value });
    return value;
  }

  /** The scope's commits, read (or brought up to date) if its tips moved since. */
  private async scope(
    name: StatsScope,
    signal?: AbortSignal,
  ): Promise<{ state: ScopeState; head: HeadInfo }> {
    const { tips, head } = await this.tips(name);
    for (let attempt = 0; ; attempt++) {
      const current = this.scopes.get(name);
      if (current && sameTips(current.tips, tips)) return { state: current, head };
      if (attempt > 5) throw new Error('The history kept changing while it was read. Try again.');
      const running = this.updates.get(name);
      if (running && !running.task.stopped) {
        try {
          await running.task.join(signal);
        } catch (error) {
          // Everyone else stopped waiting for it: start again, unless this caller left too.
          if (signal?.aborted || !isCancelled(error)) throw error;
        }
        continue;
      }
      const task = new SharedTask((taskSignal) => this.update(name, current, tips, taskSignal));
      const entry = { tips, task };
      this.updates.set(name, entry);
      const forget = () => {
        if (this.updates.get(name) === entry) this.updates.delete(name);
      };
      task.promise.then((state) => {
        this.scopes.set(name, state);
        forget();
      }, forget);
    }
  }

  private async update(
    name: StatsScope,
    previous: ScopeState | undefined,
    tips: readonly string[],
    signal: AbortSignal,
  ): Promise<ScopeState> {
    if (tips.length === 0) return { tips, ids: new Int32Array(0) };
    const old = previous?.tips ?? [];
    // Parents of the new commits are still reached (a commit, a merge, a fast-forward).
    const parents = previous ? new Set<string>() : undefined;
    const added = await this.readCommits(name, tips, old, signal, parents);
    if (!previous) return { tips, ids: added };
    let kept = previous.ids;
    // Commits only the old tips reached are gone (a branch deleted, or reset back).
    const current = new Set(tips);
    const moved = old.filter((tip) => !current.has(tip) && !parents?.has(tip));
    if (moved.length > 0) {
      const { stdout } = await this.repo.git(['rev-list', '--stdin'], {
        stdin: `${[...moved, ...tips.map((tip) => `^${tip}`)].join('\n')}\n`,
        readOnly: true,
        background: true,
        label: 'Statistics: commits gone',
        signal,
      });
      const gone = new Set<number>();
      for (const sha of stdout.split('\n')) if (sha) gone.add(this.commits.id(sha));
      if (gone.size > 0) kept = kept.filter((id) => !gone.has(id));
    }
    const ids = new Int32Array(added.length + kept.length);
    ids.set(added);
    ids.set(kept, added.length);
    return { tips, ids };
  }

  /**
   * Reads the commits `tips` reach and `exclude` does not: their numbers, newest first. Their
   * parents go into `parents`, when given.
   */
  private async readCommits(
    name: StatsScope,
    tips: readonly string[],
    exclude: readonly string[],
    signal: AbortSignal,
    parents?: Set<string>,
  ): Promise<Int32Array> {
    const ids = new IdList();
    let reported = Date.now();
    const parser = new StatsLogParser(META_FIELDS, ({ sha, fields }) => {
      const [parentList = '', authorName = '', email = '', date = ''] = fields;
      const id = this.commits.add(sha, parentList, authorName, email, date);
      if (id < 0) return;
      if (parents) for (const parent of parentList.split(' ')) if (parent) parents.add(parent);
      ids.push(id);
      if (ids.length % 512 === 0 && Date.now() - reported >= PROGRESS_EVERY) {
        reported = Date.now();
        this.options.onProgress?.({ scope: name, phase: 'commits', done: ids.length });
      }
    });
    // Starting points come on stdin: thousands of tags fit there, not on a command line.
    await this.repo.gitStream(
      ['log', '-z', '--date=raw', META_FORMAT, '--stdin'],
      (chunk) => parser.push(chunk),
      {
        stdin: `${[...tips, ...exclude.map((tip) => `^${tip}`)].join('\n')}\n`,
        readOnly: true,
        background: true,
        label: 'Statistics: read commits',
        signal,
      },
    );
    parser.end();
    return ids.take();
  }

  /** Reads the changed lines of commits (`git log --numstat`, these commits only); how many. */
  private async readLines(
    name: StatsScope,
    missing: readonly number[],
    target: number,
    signal: AbortSignal,
  ): Promise<number> {
    let computed = 0;
    let reported = 0;
    const known = target - missing.length;
    const progress = (force: boolean) => {
      if (!force && Date.now() - reported < PROGRESS_EVERY) return;
      reported = Date.now();
      this.options.onProgress?.({ scope: name, phase: 'lines', done: known + computed, total: target });
    };
    progress(true);
    const parser = new StatsLogParser(0, ({ sha, files }) => {
      const id = this.commits.id(sha);
      if (id < 0) return;
      this.lines.set(id, files);
      computed++;
      progress(false);
    });
    await this.repo.gitStream(
      [
        // Root commits count as adding their files, whatever the configuration says.
        '-c',
        'log.showRoot=true',
        'log',
        '--no-walk=unsorted',
        '--stdin',
        '-z',
        '--numstat',
        '-M',
        '--no-ext-diff',
        '--no-textconv',
        '--format=%x1e%H',
      ],
      (chunk) => parser.push(chunk),
      {
        stdin: `${missing.map((id) => this.commits.sha(id)).join('\n')}\n`,
        readOnly: true,
        background: true,
        label: 'Statistics: count changed lines',
        signal,
      },
    );
    parser.end();
    // A commit git said nothing about (it should not happen) is not asked for again.
    for (const id of missing) if (!this.lines.has(id)) this.lines.set(id, []);
    progress(true);
    // Remember a few scopes' worth (their windows), not every commit ever counted.
    const wanted = new Set<number>();
    for (const [scope, state] of this.scopes) {
      for (const id of this.target(state, this.windows.get(scope) ?? this.lineLimit)) wanted.add(id);
    }
    for (const id of missing) wanted.add(id);
    this.lines.trim(this.lineLimit * 3, (id) => wanted.has(id));
    return computed;
  }
}

function clampCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1000, Math.max(1, Math.floor(value)))
    : fallback;
}

/** Validates `stats.get` parameters from a webview (never trusted). */
export function checkStatsQuery(params: unknown): CheckedQuery {
  const { scope, range, author, sort, hotspots, lines, contributors, files, timeZone, refresh } = (params ??
    {}) as Record<string, unknown>;
  if (!isOneOf(STATS_SCOPES, scope)) throw new Error(`Unknown statistics scope: ${String(scope)}`);
  if (!isOneOf(STATS_RANGES, range)) throw new Error(`Unknown statistics range: ${String(range)}`);
  if (!isOneOf(CONTRIBUTOR_SORTS, sort)) throw new Error(`Unknown contributor order: ${String(sort)}`);
  if (!isOneOf(HOTSPOT_GROUPS, hotspots)) throw new Error(`Unknown hotspot grouping: ${String(hotspots)}`);
  if (author !== undefined && !isAuthorFilter(author)) throw new Error('Not an author name');
  const zone =
    typeof timeZone === 'string' && timeZone.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(timeZone)
      ? timeZone
      : undefined;
  return {
    scope,
    range,
    author,
    sort,
    hotspots,
    lines: checkLineCounting(lines),
    contributors: clampCount(contributors, 10),
    files: clampCount(files, 10),
    timeZone: zone,
    refresh: refresh === true,
  };
}

/** Validates a scope from a webview. */
export function checkStatsScope(scope: unknown): StatsScope {
  if (!isOneOf(STATS_SCOPES, scope)) throw new Error(`Unknown statistics scope: ${String(scope)}`);
  return scope;
}

/** Validates whose lines a webview asks to count ('latest' when it does not say). */
export function checkLineCounting(lines: unknown): LineCounting {
  if (lines === undefined) return 'latest';
  if (!isOneOf(LINE_COUNTINGS, lines)) throw new Error(`Unknown line counting: ${String(lines)}`);
  return lines;
}

export interface StatsServiceOptions {
  readonly onProgress?: (progress: StatsProgress) => void;
  /** Repositories whose statistics are kept at most. */
  readonly maxRepos?: number;
  /** Statistics nobody asked for this long (ms) are dropped. */
  readonly idleMs?: number;
}

/**
 * The statistics of the repositories looked at, kept for a while: a few repositories at most,
 * dropped after some idle minutes (a large history's commits take tens of megabytes).
 */
export class StatsService {
  private readonly repos = new Map<string, RepoStats>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly options: StatsServiceOptions = {}) {
    this.timer = setInterval(() => this.dropIdle(), 60_000);
    this.timer.unref?.();
  }

  /** The statistics of a repository (created on first use). */
  for(repo: Repository): RepoStats {
    let stats = this.repos.get(repo.id);
    if (stats?.repo !== repo) {
      stats = new RepoStats(repo, {
        // Change events (see `changed`) and refreshes say when the refs must be read again.
        tipsMaxAge: Infinity,
        onProgress: (progress) => this.options.onProgress?.({ repoId: repo.id, ...progress }),
      });
    }
    // Most recently used last.
    this.repos.delete(repo.id);
    this.repos.set(repo.id, stats);
    stats.lastUsed = Date.now();
    const max = this.options.maxRepos ?? 3;
    for (const [id, other] of this.repos) {
      if (this.repos.size <= max) break;
      if (other !== stats && !other.busy) this.repos.delete(id);
    }
    return stats;
  }

  /** A repository changed (its refs may have moved). */
  changed(repoId: string): void {
    this.repos.get(repoId)?.changed();
  }

  /** Drops the statistics of repositories that are closed. */
  retain(isOpen: (repoId: string) => boolean): void {
    for (const id of [...this.repos.keys()]) if (!isOpen(id)) this.repos.delete(id);
  }

  private dropIdle(): void {
    const idleMs = this.options.idleMs ?? 10 * 60_000;
    for (const [id, stats] of this.repos) {
      if (!stats.busy && Date.now() - stats.lastUsed > idleMs) this.repos.delete(id);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.repos.clear();
  }
}
