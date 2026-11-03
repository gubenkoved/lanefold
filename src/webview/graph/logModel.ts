import { filterTopology } from '../../shared/graph/filter';
import { GraphLayout } from '../../shared/graph/layout';
import { GraphTopology, type TopologyChunk } from '../../shared/graph/topology';
import type { CommitMeta, RefInfo, RefsSnapshot, ViewConfig, WorkingTreeSummary } from '../../shared/models';
import type { LogEnd } from '../../shared/protocol';
import { errorText } from '../bridge/errorText';
import type { HostRpc } from '../bridge/host';
import { mark } from '../perf';
import { isWorkingTreeSha, stringHash } from './format';

export type LogPhase = 'opening' | 'streaming' | 'ready' | 'error';

/** Edges longer than this many rows are drawn as stubs (keeps real-world graphs narrow). */
export const ELIDE_AFTER = 400;
export const PALETTE_SIZE = 10;

const LAYOUT_SLICE_MS = 6;
let modelCounter = 0;

const META_CACHE_LIMIT = 100_000;
const metaCaches = new Map<string, Map<string, CommitMeta>>();
/** Bumped when a cache drops entries: models then ask again for rows they already asked for. */
const trimEpochs = new WeakMap<Map<string, CommitMeta>, number>();

/** Commit metadata read so far, per cache key (a repository): commits are immutable. */
export function metaCache(repoId: string): Map<string, CommitMeta> {
  let cache = metaCaches.get(repoId);
  if (!cache) metaCaches.set(repoId, (cache = new Map()));
  return cache;
}

/** Drops the oldest tenth once the cache is full (insertion order approximates age). */
function trimMetaCache(cache: Map<string, CommitMeta>): void {
  if (cache.size <= META_CACHE_LIMIT) return;
  let excess = cache.size - META_CACHE_LIMIT * 0.9;
  for (const key of cache.keys()) {
    if (excess-- <= 0) break;
    cache.delete(key);
  }
  trimEpochs.set(cache, (trimEpochs.get(cache) ?? 0) + 1);
}
const META_BATCH = 250;
const META_PREFETCH = 120;
/** Rows whose metadata is requested as soon as the first chunk arrives. */
const FIRST_SCREEN_ROWS = 60;

/** The repository a row belongs to, in a log of several repositories (for its marker). */
export interface RowSource {
  readonly repoId: string;
  readonly name: string;
  /** Its color slot (`assignColorSlots`): its own, kept while other repositories come and go. */
  readonly colorIndex: number;
}

/**
 * Everything one log view shows: the streamed topology, its incremental layout, ref labels and
 * lazily paged commit metadata. Rendering-agnostic; the GraphView subscribes to changes.
 */
export class LogModel {
  phase: LogPhase = 'opening';
  error: string | undefined;
  topology = new GraphTopology(20);
  layout: GraphLayout;
  refs: RefsSnapshot = { refs: [], head: { detached: false, unborn: true } };
  workingTree: WorkingTreeSummary | undefined;
  loadMs = 0;

  protected logId: number | undefined;
  protected readonly buffered: TopologyChunk[] = [];
  private refsBySha = new Map<string, RefInfo[]>();
  /** Bumped when refs change (for render caches). */
  refsVersion = 0;
  /** Per-repository cache shared by every model (reloads, filters): commits are immutable. */
  protected readonly meta: Map<string, CommitMeta>;
  /** Queued for the next request, and requested but not answered yet. */
  private pendingMeta = new Set<string>();
  private inflightMeta = new Set<string>();
  /** The streamed model a filtered model was derived from. */
  source: LogModel | undefined;
  private readonly listeners = new Set<() => void>();
  private layoutScheduled = false;
  private notifyScheduled = false;
  private metaTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: (() => void)[] = [];
  protected disposed = false;
  private trunkSha: string | undefined;
  private readonly openedAt = performance.now();

  constructor(
    protected readonly rpc: HostRpc,
    readonly repoId: string,
    readonly view: ViewConfig,
    options: { stream?: boolean } = {},
  ) {
    this.meta = metaCache(repoId);
    this.layout = this.createLayout();
    if (options.stream !== false) {
      this.unsubscribe.push(
        rpc.on('log.chunk', (chunk) => this.onChunk(chunk)),
        rpc.on('log.end', (end) => this.onEnd(end)),
      );
    }
  }

  /**
   * A model showing only some of `source`'s commits (`keep[row]`), with parents rewritten so
   * the graph stays connected. Shares refs and the metadata cache with the source; its commits
   * keep their colors there (filtering does not repaint the history).
   */
  static derive(source: LogModel, keep: Uint8Array): LogModel {
    const model = source.emptyCopy();
    model.source = source;
    model.pendingMeta = source.pendingMeta;
    model.inflightMeta = source.inflightMeta;
    model.workingTree = source.workingTree;
    model.topology = filterTopology(source.topology, keep);
    model.topology.complete = true;
    model.setRefs(source.refs);
    model.layout = model.createLayout();
    model.phase = 'ready';
    model.loadMs = source.loadMs;
    // Laid out in the background like a loaded history: all of it scrolls, steps and counts.
    model.scheduleLayout();
    return model;
  }

  /**
   * For a model derived from another (see `derive`): each commit's color in the source's layout,
   * for this layout's `rowColor`. The filtered topology shares the source's commit IDs.
   */
  protected sourceColors(): ((row: number) => number | undefined) | undefined {
    const source = this.source;
    if (!source) return undefined;
    const topology = this.topology;
    return (row) => {
      const at = source.topology.rowOfId(topology.rowId(row));
      if (at < 0) return undefined;
      source.ensureLayout(at);
      return at < source.layout.rowsDone ? source.layout.nodeColor[at] : undefined;
    };
  }

  /** A model of the same log that does not stream (for {@link derive}). */
  protected emptyCopy(): LogModel {
    return new LogModel(this.rpc, this.repoId, this.view, { stream: false });
  }

  /** The host started from recently active refs only; see {@link missingRefs}. */
  partial = false;

  /** Starts loading. Resolves once the host accepted the request (rows keep streaming in). */
  async open(options: { complete?: boolean } = {}): Promise<void> {
    mark(`log-open:${this.id}`);
    try {
      const result = await this.rpc.call('log.open', {
        repoId: this.repoId,
        view: this.view,
        complete: options.complete,
      });
      if (this.disposed) {
        void this.rpc.call('log.close', { logId: result.logId }).catch(() => undefined);
        return;
      }
      mark(`log-opened:${this.id}`);
      this.logId = result.logId;
      this.partial = !!result.partial;
      this.workingTree = result.workingTree;
      this.topology = new GraphTopology(result.oidBytes);
      this.setRefs(result.refs);
      this.layout = this.createLayout();
      this.phase = result.empty ? 'ready' : 'streaming';
      if (result.empty) this.topology.complete = true;
      for (const chunk of this.buffered.splice(0)) this.onChunk(chunk);
      this.notify();
    } catch (error) {
      this.phase = 'error';
      this.error = errorText(error);
      this.notify();
    }
  }

  protected createLayout(): GraphLayout {
    return new GraphLayout(this.topology, {
      elideAfter: ELIDE_AFTER,
      paletteSize: PALETTE_SIZE,
      rowColor: this.sourceColors(),
      isTrunkTip: this.trunkSha ? (row) => this.topology.oidHex(row) === this.trunkSha : undefined,
      rowSeed: (row) => {
        const refs = this.refsBySha.get(this.topology.oidHex(row));
        const branch =
          refs?.find((ref) => ref.kind === 'branch') ?? refs?.find((ref) => ref.kind === 'remote');
        return branch
          ? stringHash(
              branch.kind === 'remote' ? branch.short.slice(branch.short.indexOf('/') + 1) : branch.short,
            )
          : undefined;
      },
    });
  }

  /** Indexes refs by commit and decides which first-parent chain is the trunk (lane 0). */
  setRefs(refs: RefsSnapshot): void {
    this.refs = refs;
    const bySha = new Map<string, RefInfo[]>();
    const hidden = new Set(this.view.hidden);
    for (const ref of refs.refs) {
      if (hidden.has(ref.name)) continue;
      const list = bySha.get(ref.target);
      if (list) list.push(ref);
      else bySha.set(ref.target, [ref]);
    }
    for (const list of bySha.values()) {
      // Current branch first, then local branches, remotes, tags.
      const order = { branch: 0, remote: 1, tag: 2 } as const;
      list.sort(
        (a, b) =>
          Number(!!b.isHead) - Number(!!a.isHead) ||
          order[a.kind] - order[b.kind] ||
          a.short.localeCompare(b.short),
      );
    }
    this.refsBySha = bySha;
    this.refsVersion++;
    this.rebuildTipIndex();

    const headSha = refs.head.sha;
    const trunkRef = refs.trunk ? refs.refs.find((ref) => ref.short === refs.trunk) : undefined;
    let trunk: string | undefined;
    if (this.view.scope.type === 'head') trunk = headSha;
    else if (this.view.scope.type === 'refs')
      trunk =
        refs.refs.find((ref) => ref.short === (this.view.scope as { refs: readonly string[] }).refs[0])
          ?.target ?? headSha;
    else trunk = trunkRef?.target ?? headSha;
    const dirty = this.workingTree && Object.values(this.workingTree).some((count) => count > 0);
    // The working-tree row sits on top of HEAD; when HEAD is the trunk tip it continues lane 0.
    this.trunkSha =
      dirty && trunk && trunk === headSha && this.view.scope.type !== 'refs'
        ? '0'.repeat(this.topology.oidBytes * 2)
        : trunk;
  }

  /** Refs that point where they did, with what else they say updated (a branch's upstream). */
  updateRefs(refs: RefsSnapshot): void {
    this.setRefs(refs);
    this.notify();
  }

  /** Updates the uncommitted-changes counts shown on the working-tree row. */
  setWorkingTree(summary: WorkingTreeSummary | undefined): void {
    this.workingTree = summary;
    this.notify();
  }

  private workingTreeRow: boolean | undefined;

  /** True when the first row is the synthetic "uncommitted changes" row. */
  get hasWorkingTreeRow(): boolean {
    if (this.topology.rowCount === 0) return false;
    this.workingTreeRow ??= this.isWorkingTree(0);
    return this.workingTreeRow;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Increments on every change notification (a snapshot for React subscriptions). */
  version = 0;
  /** Unique per model instance (cache keys that must change on reload). */
  readonly id = ++modelCounter;

  /** Coalesces change notifications to one per animation frame. */
  protected notify(): void {
    if (this.notifyScheduled || this.disposed) return;
    this.notifyScheduled = true;
    requestAnimationFrame(() => {
      this.notifyScheduled = false;
      this.version++;
      for (const listener of [...this.listeners]) listener();
    });
  }

  protected onChunk(chunk: TopologyChunk): void {
    if (this.logId === undefined) {
      this.buffered.push(chunk);
      return;
    }
    if (chunk.logId !== this.logId) return;
    const first = this.topology.rowCount === 0;
    if (first) mark(`first-chunk:${this.id}`);
    this.topology.appendChunk(chunk);
    this.indexTips();
    this.scheduleLayout();
    if (first) {
      // Ask for the first screen's metadata now, while the rows render, and paint at once:
      // the graph lays out what it shows on demand.
      this.requestMeta(0, FIRST_SCREEN_ROWS);
      if (this.metaTimer) {
        clearTimeout(this.metaTimer);
        this.flushMeta();
      }
      this.notify();
    }
  }

  protected onEnd(end: LogEnd): void {
    if (this.logId === undefined || end.logId !== this.logId) return;
    this.loadMs = performance.now() - this.openedAt;
    if (end.error) {
      this.phase = 'error';
      this.error = end.error;
    } else if (!end.cancelled) {
      this.phase = 'ready';
    }
    this.topology.complete = true;
    this.scheduleLayout();
    this.notify();
  }

  /** Lays out newly arrived rows in short slices so input and rendering stay responsive. */
  private scheduleLayout(): void {
    if (this.layoutScheduled || this.disposed) return;
    this.layoutScheduled = true;
    setTimeout(() => {
      this.layoutScheduled = false;
      const deadline = performance.now() + LAYOUT_SLICE_MS;
      while (this.layout.rowsDone < this.layout.readyRows && performance.now() < deadline)
        this.layout.run(2048);
      if (this.layout.rowsDone < this.layout.readyRows) this.scheduleLayout();
      this.notify();
    }, 0);
  }

  /** Rows that can be displayed (laid out). */
  get rowCount(): number {
    return this.layout.rowsDone;
  }

  /** Lays out synchronously up to `row` when the data is there (used for the visible window). */
  ensureLayout(row: number): void {
    const target = Math.min(row + 1, this.layout.readyRows);
    if (this.layout.rowsDone < target) this.layout.run(target - this.layout.rowsDone);
  }

  sha(row: number): string {
    return this.topology.oidHex(row);
  }

  isWorkingTree(row: number): boolean {
    return isWorkingTreeSha(this.sha(row));
  }

  isMerge(row: number): boolean {
    return this.topology.parentCount(row) > 1;
  }

  refsAt(row: number): readonly RefInfo[] | undefined {
    return this.refsBySha.get(this.sha(row));
  }

  isHead(row: number): boolean {
    return this.refs.head.sha === this.sha(row);
  }

  /** Whether a commit is checked out (in a log of several repositories: in any of them). */
  isHeadSha(sha: string): boolean {
    return this.refs.head.sha === sha;
  }

  /** Whether a row is a detached HEAD (it gets a "HEAD" pill). */
  isDetachedHead(row: number): boolean {
    return this.refs.head.detached && this.isHead(row);
  }

  /** The commits checked out (one per repository in a log of several). */
  headShas(): readonly string[] {
    return this.refs.head.sha ? [this.refs.head.sha] : [];
  }

  /** The repository of a row in a log of several repositories (undefined in a repository's own log). */
  sourceAt(_row: number): RowSource | undefined {
    return undefined;
  }

  metaAt(row: number): CommitMeta | undefined {
    return this.meta.get(this.sha(row));
  }

  metaOf(sha: string): CommitMeta | undefined {
    return this.meta.get(sha);
  }

  /** Rows whose metadata was already requested or found (skips hex conversion on every frame). */
  private metaRows = new Uint8Array(0);
  private metaEpoch = 0;

  /** Requests metadata for rows `[first, last]` (plus prefetch) that are not loaded yet. */
  requestMeta(first: number, last: number): void {
    // Entries dropped from the shared cache must be asked for again, or their rows stay blank.
    const epoch = trimEpochs.get(this.meta) ?? 0;
    if (epoch !== this.metaEpoch) {
      this.metaEpoch = epoch;
      this.metaRows.fill(0);
    }
    const from = Math.max(0, first - META_PREFETCH);
    const to = Math.min(this.topology.rowCount - 1, last + META_PREFETCH);
    if (this.metaRows.length < this.topology.rowCount) {
      const grown = new Uint8Array(Math.max(this.topology.rowCount, this.metaRows.length * 2));
      grown.set(this.metaRows);
      this.metaRows = grown;
    }
    for (let row = from; row <= to; row++) {
      if (this.metaRows[row]) continue;
      this.metaRows[row] = 1;
      const sha = this.sha(row);
      if (this.meta.has(sha) || this.pendingMeta.has(sha) || this.inflightMeta.has(sha)) continue;
      if (!isWorkingTreeSha(sha)) this.pendingMeta.add(sha);
    }
    // Also picks up work queued by a model sharing this cache that was disposed meanwhile.
    if (this.pendingMeta.size > 0 && !this.metaTimer) this.metaTimer = setTimeout(() => this.flushMeta(), 0);
  }

  private flushMeta(): void {
    this.metaTimer = undefined;
    if (this.disposed) return;
    const batch: string[] = [];
    for (const sha of this.pendingMeta) {
      if (batch.length >= META_BATCH) break;
      batch.push(sha);
    }
    if (batch.length === 0) return;
    for (const sha of batch) {
      this.pendingMeta.delete(sha);
      this.inflightMeta.add(sha);
    }
    const settle = () => {
      for (const sha of batch) this.inflightMeta.delete(sha);
      if (this.pendingMeta.size > 0 && !this.metaTimer && !this.disposed)
        this.metaTimer = setTimeout(() => this.flushMeta(), 0);
    };
    if (this.meta.size === 0) mark(`first-meta-request:${this.id}`);
    const failed = () => this.metaRows.fill(0);
    void this.fetchMeta(batch)
      .then((metas) => {
        if (this.meta.size === 0) mark(`first-meta:${this.id}`);
        for (const meta of metas) this.meta.set(meta.sha, meta);
        trimMetaCache(this.meta);
        settle();
        this.notify();
      })
      .catch(() => {
        settle();
        failed();
      });
  }

  /** Reads the metadata of commits (missing ones are left out). */
  protected fetchMeta(shas: readonly string[]): Promise<readonly CommitMeta[]> {
    return this.rpc.call('log.meta', { repoId: this.repoId, shas });
  }

  /** Row of a commit (full or abbreviated SHA), or -1. Full SHAs take constant time. */
  rowOf(sha: string): number {
    const needle = sha.toLowerCase();
    if (needle.length >= this.topology.oidBytes * 2) {
      const row = this.topology.rowOfHex(needle);
      return row < this.rowCount ? row : -1;
    }
    return this.rowsWithPrefix(needle, 1, this.rowCount)[0] ?? -1;
  }

  /**
   * Rows whose object ID starts with `prefix` (at least 4 hex digits). Compares the 32-bit seed
   * of each row first, so only candidates are converted to hex.
   */
  rowsWithPrefix(prefix: string, limit = 100, rows = this.topology.rowCount): number[] {
    const hex = prefix.toLowerCase();
    if (!/^[0-9a-f]{4,64}$/.test(hex)) return [];
    const head = hex.slice(0, 8);
    const shift = 32 - head.length * 4;
    const want = parseInt(head, 16) >>> 0;
    const topo = this.topology;
    const found: number[] = [];
    for (let row = 0; row < rows && found.length < limit; row++) {
      if (topo.seedOfId(topo.rowId(row)) >>> shift !== want) continue;
      if (hex.length <= 8 || topo.oidHex(row).startsWith(hex)) found.push(row);
    }
    return found;
  }

  /** Rows of many commits (full SHAs) among the loaded rows (laid out or not yet). */
  rowsOf(shas: Iterable<string>): Map<string, number> {
    const found = new Map<string, number>();
    for (const sha of shas) {
      const row = this.topology.rowOfHex(sha);
      if (row >= 0) found.set(sha, row);
    }
    return found;
  }

  /** First parent's SHA (undefined for root commits). */
  firstParent(row: number): string | undefined {
    return this.topology.parentCount(row) > 0
      ? this.topology.oidHexOfId(this.topology.parentId(row, 0))
      : undefined;
  }

  /** Rows of ref tips and HEAD, indexed as rows arrive (for markers and jumps). */
  readonly tipRows = new Map<string, number>();
  private tipPrefixes = new Set<number>();
  private indexedRows = 0;

  /** Commits whose rows are indexed as they arrive: ref targets and HEAD. */
  protected tipTargets(): string[] {
    return [...this.refs.refs.map((ref) => ref.target), ...this.headShas()];
  }

  private rebuildTipIndex(): void {
    const prefixes = new Set<number>();
    for (const sha of this.tipTargets()) prefixes.add(parseInt(sha.slice(0, 8), 16) >>> 0);
    this.tipPrefixes = prefixes;
    this.tipRows.clear();
    this.indexedRows = 0;
    this.indexTips();
  }

  /** Records rows whose commit is a ref target (4-byte prefix check, hex only on a hit). */
  private indexTips(): void {
    const topo = this.topology;
    for (let row = this.indexedRows; row < topo.rowCount; row++) {
      const id = topo.rowId(row);
      if (this.tipPrefixes.has(topo.seedOfId(id))) this.tipRows.set(topo.oidHexOfId(id), row);
    }
    this.indexedRows = topo.rowCount;
  }

  /**
   * Refs of this view whose commit is not in the loaded history. Only possible for a partial
   * load (old refs not reachable from the recent ones); the view then needs a complete load.
   */
  missingRefs(): RefInfo[] {
    if (!this.partial || this.phase !== 'ready') return [];
    const scope = this.view.scope.type;
    const hidden = new Set(this.view.hidden);
    const extra = new Set(this.view.extra);
    return this.refs.refs.filter(
      (ref) =>
        (scope === 'all' || ref.kind === 'branch' || extra.has(ref.name)) &&
        !hidden.has(ref.name) &&
        !this.tipRows.has(ref.target),
    );
  }

  /** Rows of commits whose parent is `row` (children), in row order. */
  childrenOf(row: number): number[] {
    const id = this.topology.rowId(row);
    const children: number[] = [];
    for (let r = Math.max(0, row - 2000); r < row; r++) {
      const count = this.topology.parentCount(r);
      for (let k = 0; k < count; k++) if (this.topology.parentId(r, k) === id) children.push(r);
    }
    return children;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    if (this.metaTimer) clearTimeout(this.metaTimer);
    if (this.logId !== undefined && this.phase === 'streaming') {
      void this.rpc.call('log.close', { logId: this.logId }).catch(() => undefined);
    }
    this.listeners.clear();
  }
}
