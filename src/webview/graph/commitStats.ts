/**
 * What commits changed (files, lines), for the graph's Files and Lines columns: read from git
 * only while one of those columns shows, for the commits on screen and a few around them, and
 * remembered per repository (commits are immutable).
 *
 * Counting files compares trees and is quick; counting lines reads the files' contents and takes
 * many times longer. So the two are asked for apart: files first, in large batches, then lines
 * (if their column shows) in small ones sized by the files just counted, so that one huge commit
 * is read by itself and does not hold the rows around it back.
 */

import type { CommitStats } from '../../shared/models';

/** Which counts the graph shows: none, files, or files and lines. */
export type StatsWant = 'none' | 'files' | 'lines';

/** Reads commits' counts (with their lines or not); commits it leaves out are not asked for again. */
export type FetchStats = (
  shas: readonly string[],
  lines: boolean,
  signal: AbortSignal,
) => Promise<readonly CommitStats[]>;

const CACHE_LIMIT = 100_000;
const caches = new Map<string, Map<string, CommitStats>>();

/** Counts read so far, per cache key (a repository). */
export function statsCache(key: string): Map<string, CommitStats> {
  let cache = caches.get(key);
  if (!cache) caches.set(key, (cache = new Map()));
  return cache;
}

/** Keeps what was read with lines when the same commit arrives without them. */
function remember(cache: Map<string, CommitStats>, stats: CommitStats): void {
  if (!stats.lines && cache.get(stats.sha)?.lines) return;
  cache.set(stats.sha, stats);
}

/** Drops the oldest tenth once the cache is full (insertion order approximates age). */
function trim(cache: Map<string, CommitStats>): void {
  if (cache.size <= CACHE_LIMIT) return;
  let excess = cache.size - CACHE_LIMIT * 0.9;
  for (const key of cache.keys()) {
    if (excess-- <= 0) break;
    cache.delete(key);
  }
}

/** Commits per request for files. */
export const FILES_BATCH = 120;
/** Commits per request for lines, at most. */
export const LINES_BATCH = 40;
/** A request for lines takes commits until they changed this many files (one commit at least). */
export const LINES_BATCH_FILES = 1500;
/** The graph must show the same rows for this long before git is asked (scrolling asks nothing). */
export const SETTLE_MS = 70;

interface Request {
  readonly shas: readonly string[];
  readonly controller: AbortController;
}

/** Loads the counts of the commits a graph shows; see the file's comment. */
export class CommitStatsLoader {
  /** The commits wanted, nearest first; lines are read for the first `near` of them. */
  private wanted: readonly string[] = [];
  private near = 0;
  private tier: StatsWant = 'none';
  /** The request in flight for files, and the one for lines. */
  private files: Request | undefined;
  private lines: Request | undefined;
  /** Commits a read left out or failed on: not asked for again until the graph shows other rows. */
  private readonly failed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly cache: Map<string, CommitStats>,
    private readonly fetch: FetchStats,
    /** New counts arrived. */
    private readonly onChange: () => void,
  ) {}

  /**
   * The commits the graph shows now and wants `tier` of: `shas` nearest first (those on screen,
   * then those around), lines being read for the first `near` only.
   */
  want(shas: readonly string[], near: number, tier: StatsWant): void {
    if (this.disposed) return;
    this.wanted = tier === 'none' ? [] : shas;
    this.near = near;
    this.tier = tier;
    this.failed.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (tier === 'none') {
      // The columns went: nothing more is read for them.
      this.pump();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, SETTLE_MS);
  }

  /** Stops what no longer serves a wanted commit, and starts the next request of each kind. */
  private pump(): void {
    if (this.disposed) return;
    const wanted = new Set(this.wanted);
    for (const request of [this.files, this.lines]) {
      if (request && !request.shas.some((sha) => wanted.has(sha))) request.controller.abort();
    }
    if (this.tier === 'none') return;
    if (!this.files) {
      const batch: string[] = [];
      for (const sha of this.wanted) {
        if (this.cache.has(sha) || this.failed.has(sha)) continue;
        batch.push(sha);
        if (batch.length >= FILES_BATCH) break;
      }
      if (batch.length > 0) this.files = this.start(batch, false);
    }
    if (this.tier === 'lines' && !this.lines) {
      const batch: string[] = [];
      let weight = 0;
      for (let i = 0; i < Math.min(this.near, this.wanted.length); i++) {
        const sha = this.wanted[i]!;
        const stats = this.cache.get(sha);
        // Its files are counted first: they say how much there is to read.
        if (!stats || stats.lines || this.failed.has(sha)) continue;
        const files = stats.added + stats.modified + stats.removed;
        if (batch.length > 0 && weight + files > LINES_BATCH_FILES) break;
        batch.push(sha);
        weight += files;
        if (batch.length >= LINES_BATCH) break;
      }
      if (batch.length > 0) this.lines = this.start(batch, true);
    }
  }

  private start(shas: readonly string[], lines: boolean): Request {
    const request: Request = { shas, controller: new AbortController() };
    const done = (found: readonly CommitStats[] | undefined) => {
      if (lines && this.lines === request) this.lines = undefined;
      if (!lines && this.files === request) this.files = undefined;
      if (this.disposed) return;
      if (found) {
        for (const stats of found) remember(this.cache, stats);
        trim(this.cache);
      }
      // Stopped: its commits are asked for again when they are wanted. Otherwise what did not
      // come is not asked for again.
      if (!request.controller.signal.aborted) {
        for (const sha of shas) {
          const stats = this.cache.get(sha);
          if (!stats || (lines && !stats.lines)) this.failed.add(sha);
        }
      }
      if (found && found.length > 0) this.onChange();
      this.pump();
    };
    this.fetch(shas, lines, request.controller.signal).then(done, () => done(undefined));
    return request;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.files?.controller.abort();
    this.lines?.controller.abort();
  }
}
