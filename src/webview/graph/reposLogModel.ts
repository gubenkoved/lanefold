import { GraphLayout } from '../../shared/graph/layout';
import { GraphTopology } from '../../shared/graph/topology';
import type { CommitMeta, CommitStats, HeadInfo, RefInfo, ViewConfig } from '../../shared/models';
import type { LogEnd, ReposLogSource } from '../../shared/protocol';
import { errorText } from '../bridge/errorText';
import type { HostRpc } from '../bridge/host';
import { mark } from '../perf';
import { stringHash } from './format';
import { lanesClearOf } from './hues';
import { ELIDE_AFTER, LogModel, metaCache, PALETTE_SIZE, type RowSource } from './logModel';
import { lineColors } from './mainLines';
import { repoHue } from './repoColorSlots';
import { repoLaneColor } from './repoColors';

/** How the view names and colors a repository. */
export interface RepoLabel {
  readonly name: string;
  readonly colorIndex: number;
}

/** One repository (object store) of the log: what the host read of it, and how it shows. */
export interface LogSource extends RowSource, ReposLogSource {
  /** Its rows' repository index. */
  readonly index: number;
  /** The HEADs of its open worktrees (its own first). */
  readonly heads: readonly HeadInfo[];
}

/** One metadata cache for every log of several repositories (rows are looked up by commit). */
const META_KEY = '\0repositories';

const KIND_ORDER = { branch: 0, remote: 1, tag: 2 } as const;

/** Refs by the commit they point at; current branch first, then branches, remotes, tags. */
function refsByCommit(refs: readonly RefInfo[]): Map<string, RefInfo[]> {
  const bySha = new Map<string, RefInfo[]>();
  for (const ref of refs) {
    const list = bySha.get(ref.target);
    if (list) list.push(ref);
    else bySha.set(ref.target, [ref]);
  }
  for (const list of bySha.values()) {
    list.sort(
      (a, b) =>
        Number(!!b.isHead) - Number(!!a.isHead) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        a.short.localeCompare(b.short),
    );
  }
  return bySha;
}

/**
 * The log of several repositories: one stream merged by commit date whose rows name their
 * repository. Lanes are laid out as usual (no trunk lane: each repository has its own main
 * line, drawn in the repository's color, which other lanes keep clear of); ref pills, HEADs and
 * metadata are each repository's own. A commit several repositories have (clones, forks) is one
 * row, the first repository's; the refs the others have on it carry their repository's name.
 */
export class ReposLogModel extends LogModel {
  /** The repositories, in row-index order (see `LogSource.index`). */
  sources: readonly LogSource[] = [];
  /** Repositories whose history stopped with an error while streaming (by index). */
  sourceErrors: Readonly<Record<number, string>> = {};
  private sourceRefs: readonly Map<string, RefInfo[]>[] = [];
  private heads: ReadonlySet<string> = new Set();
  /** Commits that refs of several repositories point at (their pills get labelled). */
  private sharedTips: ReadonlySet<string> = new Set();
  private readonly labelled = new Map<string, readonly RefInfo[]>();
  /** Where each ref shown comes from (pills open menus): its repository, and the ref as named there. */
  private refOrigins = new WeakMap<RefInfo, { readonly index: number; readonly ref: RefInfo }>();

  constructor(
    rpc: HostRpc,
    /** The repositories asked for, in order (the first one gets commits several have). */
    readonly repoIds: readonly string[],
    view: ViewConfig,
    private readonly label: (repoId: string) => RepoLabel,
    options: { stream?: boolean } = {},
  ) {
    super(rpc, META_KEY, view, options);
  }

  override async open(options: { complete?: boolean } = {}): Promise<void> {
    mark(`log-open:${this.id}`);
    try {
      const result = await this.rpc.call('log.openRepos', {
        repoIds: this.repoIds,
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
      this.topology = new GraphTopology(result.oidBytes);
      this.setSources(result.sources);
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

  /** Adopts the repositories the host read (in row-index order), with their refs and HEADs. */
  private setSources(sources: readonly ReposLogSource[]): void {
    this.sources = sources.map((source, index) => ({
      ...source,
      ...this.label(source.repoId),
      repoId: source.repoId,
      index,
      heads: [source.refs.head, ...source.worktreeHeads],
    }));
    this.sourceRefs = this.sources.map((source) => refsByCommit(source.refs.refs));
    this.heads = new Set(
      this.sources.flatMap((source) => source.heads.flatMap((h) => (h.sha ? [h.sha] : []))),
    );
    const owners = new Map<string, number>();
    const shared = new Set<string>();
    this.refOrigins = new WeakMap();
    for (const [index, bySha] of this.sourceRefs.entries()) {
      for (const [sha, refs] of bySha) {
        for (const ref of refs) this.refOrigins.set(ref, { index, ref });
        const owner = owners.get(sha);
        if (owner === undefined) owners.set(sha, index);
        else if (owner !== index) shared.add(sha);
      }
    }
    this.sharedTips = shared;
    this.labelled.clear();
    // Every repository's refs together: scrollbar markers, finding refs by name, the check for
    // refs a partial load missed.
    this.setRefs({
      refs: this.sources.flatMap((source) => source.refs.refs),
      head: { detached: false, unborn: false },
    });
  }

  protected override emptyCopy(): LogModel {
    const copy = new ReposLogModel(this.rpc, this.repoIds, this.view, this.label, { stream: false });
    copy.sources = this.sources;
    copy.sourceErrors = this.sourceErrors;
    copy.sourceRefs = this.sourceRefs;
    copy.heads = this.heads;
    copy.sharedTips = this.sharedTips;
    copy.refOrigins = this.refOrigins;
    return copy;
  }

  protected override onEnd(end: LogEnd): void {
    if (this.logId !== undefined && end.logId === this.logId) this.sourceErrors = end.sourceErrors ?? {};
    super.onEnd(end);
  }

  /** Each repository's main line: its default branch's tip (HEAD's in a view of HEADs), and its color. */
  private mainLineTips(): Map<string, number> {
    const tips = new Map<string, number>();
    // Also called while the base class is being built, before `sources` is set.
    for (const source of this.sources ?? []) {
      const { refs } = source;
      const trunk = refs.trunk
        ? refs.refs.find((ref) => ref.kind === 'branch' && ref.short === refs.trunk)
        : undefined;
      const tip = this.view.scope.type === 'head' ? refs.head.sha : (trunk?.target ?? refs.head.sha);
      if (tip && !tips.has(tip)) tips.set(tip, repoLaneColor(source.colorIndex));
    }
    return tips;
  }

  protected override createLayout(): GraphLayout {
    return new GraphLayout(this.topology, {
      elideAfter: ELIDE_AFTER,
      paletteSize: PALETTE_SIZE,
      // Each repository's main line in its color (a filtered view: every commit in its color in
      // the whole log); other lanes take colors clear of the repositories'.
      rowColor: this.sourceColors() ?? lineColors(this.topology, this.mainLineTips()),
      laneColors: lanesClearOf(
        (this.sources ?? []).map((source) => repoHue(source.colorIndex)),
        PALETTE_SIZE,
      ),
      // Lanes take the colors of the branches they start at, as in a repository's own log.
      rowSeed: (row) => {
        const refs = this.sourceRefs[this.topology.rowRepo(row)]?.get(this.topology.oidHex(row));
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

  override sourceAt(row: number): LogSource | undefined {
    return this.sources[this.topology.rowRepo(row)];
  }

  /** The repository of a loaded commit. */
  sourceOf(sha: string): LogSource | undefined {
    const row = this.topology.rowOfHex(sha);
    return row < 0 ? undefined : this.sourceAt(row);
  }

  /** The repository of a ref as `refsAt` returns it, and the ref as that repository names it. */
  refOrigin(ref: RefInfo): { readonly source: LogSource; readonly ref: RefInfo } | undefined {
    const origin = this.refOrigins.get(ref);
    const source = origin && this.sources[origin.index];
    return source && { source, ref: origin.ref };
  }

  override refsAt(row: number): readonly RefInfo[] | undefined {
    const sha = this.sha(row);
    const index = this.topology.rowRepo(row);
    const own = this.sourceRefs[index]?.get(sha);
    if (!this.sharedTips.has(sha)) return own;
    const key = `${index}\0${sha}`;
    let refs = this.labelled.get(key);
    if (!refs) {
      // The other repositories' refs on a commit they share, named with their repository; a tag
      // this repository has too (clones fetch them) adds nothing.
      const ownTags = new Set(own?.filter((ref) => ref.kind === 'tag').map((ref) => ref.name));
      const foreign = this.sources.flatMap((source) =>
        source.index === index
          ? []
          : (this.sourceRefs[source.index]?.get(sha) ?? [])
              .filter((ref) => !(ref.kind === 'tag' && ownTags.has(ref.name)))
              .map((ref) => {
                const copy: RefInfo = { ...ref, short: `${source.name}: ${ref.short}` };
                this.refOrigins.set(copy, { index: source.index, ref });
                return copy;
              }),
      );
      refs = [...(own ?? []), ...foreign];
      this.labelled.set(key, refs);
    }
    return refs;
  }

  override isHead(row: number): boolean {
    return this.heads.has(this.sha(row));
  }

  override isHeadSha(sha: string): boolean {
    return this.heads.has(sha);
  }

  override isDetachedHead(row: number): boolean {
    const sha = this.sha(row);
    return !!this.sourceAt(row)?.heads.some((head) => head.detached && head.sha === sha);
  }

  override headShas(): readonly string[] {
    return [...this.heads];
  }

  /**
   * Metadata from each row's repository (one request per repository); what single-repository
   * views already read is not asked for again.
   */
  protected override async fetchMeta(shas: readonly string[]): Promise<readonly CommitMeta[]> {
    const found: CommitMeta[] = [];
    const wanted = new Map<string, string[]>();
    for (const sha of shas) {
      const source = this.sourceOf(sha);
      if (!source) continue;
      const known = metaCache(source.repoId).get(sha);
      if (known) found.push(known);
      else {
        const list = wanted.get(source.repoId);
        if (list) list.push(sha);
        else wanted.set(source.repoId, [sha]);
      }
    }
    let failure: unknown;
    await Promise.all(
      [...wanted].map(async ([repoId, list]) => {
        try {
          found.push(...(await this.rpc.call('log.meta', { repoId, shas: list })));
        } catch (error) {
          failure = error;
        }
      }),
    );
    if (failure !== undefined) {
      // What arrived is kept; the rest is asked for again.
      for (const meta of found) this.meta.set(meta.sha, meta);
      throw failure;
    }
    return found;
  }

  /** Counts from each commit's repository (one request per repository). */
  protected override async fetchStats(
    shas: readonly string[],
    lines: boolean,
    signal: AbortSignal,
  ): Promise<readonly CommitStats[]> {
    const wanted = new Map<string, string[]>();
    for (const sha of shas) {
      const source = this.sourceOf(sha);
      if (!source) continue;
      const list = wanted.get(source.repoId);
      if (list) list.push(sha);
      else wanted.set(source.repoId, [sha]);
    }
    const found = await Promise.all(
      [...wanted].map(([repoId, list]) =>
        // A repository that fails leaves its commits out: the others' counts still show.
        this.rpc.call('log.stats', { repoId, shas: list, lines }, { signal }).catch(() => []),
      ),
    );
    return found.flat();
  }
}
