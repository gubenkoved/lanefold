import { readFile } from 'node:fs/promises';
import { viewShowsWorkingTree, type GitInfo, type RepoChangeKind } from '../../shared/models';
import { isObjectId } from '../../shared/oid';
import type { HostApi, HostEvents, WebviewApi, WebviewEvents } from '../../shared/protocol';
import { RpcEndpoint, type Handlers, type RpcTransport } from '../../shared/rpc';
import type { ConsoleLog } from '../console/consoleLog';
import { filePaths } from '../git/args';
import { isSupportedVersion } from '../git/binary';
import type { GitRunner } from '../git/runner';
import { LogEngine, type LogStream } from '../log/logEngine';
import { preloadTips, revListArgs } from '../log/revList';
import { validJournal } from '../ops/journal';
import { RepoOperations } from '../ops/operations';
import { conflictStages } from '../ops/opState';
import { takeSnapshot } from '../ops/snapshot';
import { readCodeHosts } from '../repo/codeHosts';
import {
  applyToIndex,
  checkArea,
  checkFilePath,
  differsOnDisk,
  lineRequest,
  linePatchFor,
  readFileDiff,
  toFileHunks,
} from '../repo/lineStaging';
import { formatPatches, patchFileName } from '../repo/patches';
import { readReflog } from '../repo/reflog';
import type { RepositoryRegistry } from '../repo/registry';
import { RepoData } from '../repo/repoData';
import type { Repository } from '../repo/repository';
import { linkedRepositoryFolder, readSubmoduleConflicts, readSubmodules } from '../repo/submodules';
import { readWorktrees } from '../repo/worktrees';
import { checkLineCounting, checkStatsQuery, checkStatsScope, StatsService } from '../stats/repoStats';
import { DisposableStore, Emitter, type Disposable } from '../util/emitter';
import { paths } from '../util/paths';
import {
  checkCount,
  checkFilePaths,
  checkObjectId,
  checkObjectIds,
  checkOneOf,
  checkRev,
  checkWebUrl,
} from './params';
import type { Platform } from './platform';
import { openReposLog } from './reposLog';

export type HostEndpoint = RpcEndpoint<HostApi, WebviewApi, HostEvents, WebviewEvents>;

const COMPARE_MODES = ['three-dot', 'two-dot'] as const;

/** The commits a merge in progress brings in (MERGE_HEAD; several for an octopus merge). */
async function mergeHeads(repo: Repository): Promise<string[]> {
  try {
    const text = await readFile(repo.gitPath('MERGE_HEAD'), 'utf8');
    return text.split('\n').filter(isObjectId);
  } catch {
    return [];
  }
}

export interface BackendOptions {
  readonly platform: Platform;
  readonly registry: RepositoryRegistry;
  readonly console: ConsoleLog;
}

/**
 * Implements the webview-facing API on top of the core services. One backend serves every
 * connected webview (the panel and any pop-out editor tabs) and broadcasts events to all.
 */
export class Backend implements Disposable {
  private readonly endpoints = new Set<HostEndpoint>();
  private readonly ready = new Set<HostEndpoint>();
  private readonly onDidConnectEmitter = new Emitter<HostEndpoint>();
  /** Fires when a webview finished loading and is ready for calls. */
  readonly onDidConnect = this.onDidConnectEmitter.event;
  private readonly store = new DisposableStore();
  private runner: GitRunner | undefined;
  private gitError: string | undefined;
  private readonly logEngine: LogEngine;
  private readonly repoData = new Map<string, RepoData>();
  private readonly repoOps = new Map<string, RepoOperations>();
  /** Repositories running an operation: changes seen meanwhile, broadcast once it is over. */
  private readonly held = new Map<string, Set<RepoChangeKind>>();
  /** Open log streams per webview, cancelled when the webview goes away. */
  private readonly logStreams = new Map<HostEndpoint, Map<number, LogStream>>();
  private readonly transports = new Map<HostEndpoint, RpcTransport>();
  /** How each view's host brings it forward, with keyboard focus (a view that can be). */
  private readonly reveals = new Map<HostEndpoint, () => void>();
  /** The main view (the panel), which host commands fall back to. */
  private primary: HostEndpoint | undefined;
  /**
   * The view that had focus last, on screen or not: commands such as Undo act there, and only
   * there, and a command that needs a view brings it back when none is on screen.
   */
  private lastFocused: HostEndpoint | undefined;
  /** Commits read for the Statistics view, kept per repository for a while. */
  private readonly stats = new StatsService({
    onProgress: (progress) => this.broadcast('stats.progress', progress),
  });

  constructor(private readonly options: BackendOptions) {
    const { registry, console, platform } = options;
    this.logEngine = new LogEngine({ workerPath: platform.logWorkerPath, listener: console });
    this.store.add(
      registry.onDidChangeRepos(() => {
        // Drop cached data for repositories that were closed.
        for (const [id, data] of this.repoData) {
          if (!registry.get(id)) {
            data.dispose();
            this.repoData.delete(id);
            this.repoOps.get(id)?.dispose();
            this.repoOps.delete(id);
          }
        }
        this.stats.retain((id) => registry.get(id) !== undefined);
        this.broadcast('repos.changed', this.reposPayload());
      }),
    );
    this.store.add(
      registry.onDidChangeRepo(({ repo, kinds }) => {
        this.repoData.get(repo.id)?.changed();
        this.stats.changed(repo.id);
        // While an operation runs, git's intermediate states are not worth reloading for.
        const held = this.held.get(repo.id);
        if (held) for (const kind of kinds) held.add(kind);
        else this.broadcast('repo.changed', { repoId: repo.id, kinds: [...kinds] });
      }),
    );
    this.store.add(console.onDidChange((entry) => this.broadcast('console.entry', entry)));
    this.store.add(platform.onDidChangeSettings((settings) => this.broadcast('settings.changed', settings)));
  }

  /** Called once git has been located (or failed to be). Views that loaded first reload. */
  setGit(runner: GitRunner | undefined, error?: string): void {
    this.runner = runner;
    this.gitError = error;
    this.broadcast('app.resync', {});
  }

  /**
   * Attaches a webview; the returned endpoint is disposed by {@link disconnect}. The `primary`
   * view (the panel) is where host commands go when no other view is in use; `reveal` brings the
   * view forward with keyboard focus (see {@link showView}).
   */
  connect(
    transport: RpcTransport,
    options: { readonly primary?: boolean; readonly reveal?: () => void } = {},
  ): HostEndpoint {
    this.logEngine.warmUp();
    const endpoint: HostEndpoint = new RpcEndpoint(transport);
    endpoint.implement(this.handlers(endpoint));
    endpoint.on('ui.ready', () => {
      this.ready.add(endpoint);
      this.onDidConnectEmitter.fire(endpoint);
    });
    endpoint.on('ui.focus', ({ focused }) => {
      if (focused) this.lastFocused = endpoint;
    });
    this.endpoints.add(endpoint);
    this.transports.set(endpoint, transport);
    if (options.reveal) this.reveals.set(endpoint, options.reveal);
    if (options.primary) this.primary = endpoint;
    return endpoint;
  }

  disconnect(endpoint: HostEndpoint): void {
    for (const stream of this.logStreams.get(endpoint)?.values() ?? []) stream.cancel();
    this.logStreams.delete(endpoint);
    this.endpoints.delete(endpoint);
    this.ready.delete(endpoint);
    this.transports.delete(endpoint);
    this.reveals.delete(endpoint);
    if (this.primary === endpoint) this.primary = undefined;
    if (this.lastFocused === endpoint) this.lastFocused = undefined;
    endpoint.dispose();
  }

  /** Webviews whose script has loaded and registered its handlers. */
  get readyConnections(): readonly HostEndpoint[] {
    return [...this.ready];
  }

  /** Whether the primary view is connected and ready for commands. */
  get primaryReady(): boolean {
    return this.primary !== undefined && this.ready.has(this.primary);
  }

  broadcast<K extends keyof HostEvents & string>(event: K, payload: HostEvents[K]): void {
    for (const endpoint of this.endpoints) endpoint.emit(event, payload);
  }

  /** Whether a view is connected and ready for commands. */
  private usable(endpoint: HostEndpoint | undefined): endpoint is HostEndpoint {
    return endpoint !== undefined && this.ready.has(endpoint);
  }

  /** The view a command goes to among those on screen: the focused one, else the primary, else any. */
  private onScreen(): HostEndpoint | undefined {
    return [this.lastFocused, this.primary, ...this.ready].find(
      (endpoint): endpoint is HostEndpoint =>
        this.usable(endpoint) && this.transports.get(endpoint)?.visible !== false,
    );
  }

  /**
   * The view in use, where a command that needs a view goes: one on screen (see
   * {@link sendCommand}), so that nothing moves while Lanefold is in sight; else the view that
   * had focus last, wherever it is hidden. Undefined when there is neither: the host opens the
   * primary view then.
   */
  viewInUse(): HostEndpoint | undefined {
    return this.onScreen() ?? (this.usable(this.lastFocused) ? this.lastFocused : undefined);
  }

  /** Whether `endpoint` is the primary view (the panel) rather than one popped out of it. */
  isPrimary(endpoint: HostEndpoint): boolean {
    return endpoint === this.primary;
  }

  /** Brings a view forward, with keyboard focus (what its host does for it; nothing without one). */
  showView(endpoint: HostEndpoint): void {
    this.reveals.get(endpoint)?.();
  }

  /**
   * Runs a command in one view, never in several (an Undo must undo once): the focused view if
   * it is on screen, else the primary one, else any view on screen. With `to: 'primary'` only
   * the primary view qualifies (it may still be opening); a view given as `to` takes it itself
   * (hidden, it runs once shown). Returns whether a view took it.
   */
  sendCommand(
    command: string,
    args?: unknown,
    to: 'focused' | 'primary' | HostEndpoint = 'focused',
  ): boolean {
    const candidate = to === 'focused' ? this.onScreen() : to === 'primary' ? this.primary : to;
    const target = this.usable(candidate) ? candidate : undefined;
    target?.emit('command.run', { command, args });
    return target !== undefined;
  }

  private gitInfo(): GitInfo | undefined {
    const binary = this.runner?.binary;
    return (
      binary && {
        path: binary.path,
        version: binary.version.raw,
        supported: isSupportedVersion(binary.version),
      }
    );
  }

  private reposPayload() {
    return {
      repos: this.options.registry.all.map((repo) => repo.summary()),
      activeRepoId: this.options.registry.active?.id,
    };
  }

  private repo(repoId: string): Repository {
    const repo = this.options.registry.get(repoId);
    if (!repo) throw Object.assign(new Error(`Unknown repository: ${repoId}`), { code: 'unknownRepo' });
    return repo;
  }

  private data(repoId: string): RepoData {
    let data = this.repoData.get(repoId);
    if (!data) {
      data = new RepoData(this.repo(repoId));
      this.repoData.set(repoId, data);
    }
    return data;
  }

  private ops(repoId: string): RepoOperations {
    let ops = this.repoOps.get(repoId);
    if (!ops) {
      const { platform } = this.options;
      const key = `journal:${repoId}`;
      ops = new RepoOperations(this.repo(repoId), this.data(repoId), {
        store: {
          load: () => validJournal(platform.storageGet(key)),
          save: (journal) => void platform.storageSet(key, journal),
        },
        rebaseScript: platform.sequenceEditorPath
          ? { node: process.execPath, sequenceEditor: platform.sequenceEditorPath }
          : undefined,
      });
      ops.onDidChange((undo) => this.broadcast('op.changed', { repoId, undo }));
      this.repoOps.set(repoId, ops);
    }
    return ops;
  }

  /**
   * Runs an operation with repository change events held back; views then reload once, for the
   * final state (the watcher would report it a bit later anyway).
   */
  private async operation<T extends { status: string }>(repoId: string, task: () => Promise<T>): Promise<T> {
    const outer = !this.held.has(repoId);
    if (outer) this.held.set(repoId, new Set());
    let result: T | undefined;
    try {
      result = await task();
      return result;
    } finally {
      if (outer) {
        const held = this.held.get(repoId)!;
        this.held.delete(repoId);
        const kinds = new Set(held);
        if (result?.status !== 'refused') {
          for (const kind of ['head', 'refs', 'index', 'worktree', 'opState', 'stash'] as const)
            kinds.add(kind);
        }
        this.options.registry.notifyChange(repoId, kinds);
      }
    }
  }

  /** Tells views that something changed the repository (the watcher would, a bit later). */
  private changed(repoId: string): void {
    this.options.registry.notifyChange(repoId, ['head', 'refs', 'index', 'worktree', 'opState', 'stash']);
  }

  /**
   * Changes the index once the operations queued before are done with it (both would take
   * index.lock), then tells the views.
   */
  private async indexChange(repoId: string, task: (repo: Repository) => Promise<unknown>): Promise<void> {
    const repo = this.repo(repoId);
    await this.ops(repoId).enqueue(() => task(repo));
    this.options.registry.notifyChange(repoId, ['index', 'worktree']);
  }

  private handlers(endpoint: HostEndpoint): Handlers<HostApi> {
    const { registry, console, platform } = this.options;
    return {
      'app.init': () => {
        const repos = this.reposPayload();
        return {
          git: this.gitInfo(),
          gitError: this.gitError,
          ...repos,
          settings: platform.getSettings(),
          tabs: repos.activeRepoId ? platform.storageGet(`ui:tabs:${repos.activeRepoId}`) : undefined,
        };
      },

      'host.command': ({ command, args }) => platform.runCommand(command, args),
      'repo.select': ({ repoId }) => {
        registry.setActive(repoId);
      },
      'repo.state': async ({ repoId }) => ({ repoId, head: await this.data(repoId).head({ shared: true }) }),
      'console.history': () => console.history(),
      'console.clear': () => console.clear(),
      // The webview's own keys live apart from the host's (the journal must not be writable).
      'storage.get': ({ key }) => platform.storageGet(`ui:${key}`),
      'storage.set': ({ key, value }) => platform.storageSet(`ui:${key}`, value),

      'log.open': async ({ repoId, view, complete }) => {
        const repo = this.repo(repoId);
        const data = this.data(repoId);
        // Metadata requests follow right after the first rows.
        data.warmUp();
        const [refs, workingTree] = await Promise.all([
          data.refs({ shared: true }),
          data.workingTree({ shared: true }).catch(() => undefined),
        ]);
        const tips = complete ? undefined : preloadTips(view, refs);
        const query = revListArgs(view, refs.head, platform.getSettings().logOrder, { tips });
        const oidBytes = repo.objectFormat === 'sha256' ? 32 : 20;
        let streams = this.logStreams.get(endpoint);
        if (!streams) this.logStreams.set(endpoint, (streams = new Map()));
        // Uncommitted changes appear as a synthetic first row ("all zeros" object ID) whose parent is
        // HEAD, so the working tree shows up in the graph right above the checked-out commit. Before
        // the first commit it has no parent: it is where that commit will be made.
        const head = refs.head.sha;
        const dirty =
          workingTree &&
          workingTree.staged + workingTree.unstaged + workingTree.untracked + workingTree.conflicted > 0;
        const showsChanges = !!dirty && viewShowsWorkingTree(view);
        if (!query.args && !(showsChanges && !head)) {
          const logId = -Date.now();
          queueMicrotask(() => endpoint.emit('log.end', { logId, rowCount: 0, durationMs: 0 }));
          return { logId, oidBytes, refs, workingTree, empty: true };
        }
        const owned = streams;
        const zeros = '0'.repeat(oidBytes * 2);
        // During a merge the changes become a merge commit: the incoming commits are its parents too.
        const parents = showsChanges && head ? [head, ...(await mergeHeads(repo))] : [];
        const prefix = showsChanges ? `${[zeros, ...parents].join(' ')}\n` : '';
        const stream = this.logEngine.open(
          repo,
          // Nothing to list but the changes: rev-list with no starting points prints nothing.
          query.args ?? ['rev-list', '--stdin'],
          {
            onChunk: (chunk) => endpoint.emit('log.chunk', chunk),
            onEnd: (info) => {
              owned.delete(stream.logId);
              endpoint.emit('log.end', { logId: stream.logId, ...info });
            },
          },
          prefix,
          query.args ? query.stdin : '',
        );
        owned.set(stream.logId, stream);
        return { logId: stream.logId, oidBytes, refs, workingTree, empty: false, partial: !!tips };
      },
      'log.close': ({ logId }) => {
        const streams = this.logStreams.get(endpoint);
        streams?.get(logId)?.cancel();
        streams?.delete(logId);
      },
      'log.meta': ({ repoId, shas }) => this.data(repoId).commitMetas(shas),
      'log.stats': ({ repoId, shas, lines }, { signal }) =>
        this.data(repoId).commitStats(checkObjectIds(shas, 500), lines === true, signal),
      'log.search': async ({ repoId, view, query, limit }, { signal }) => {
        const data = this.data(repoId);
        const head = await data.head({ shared: true });
        return data.search(view, head, query, checkCount(limit, 20_000, 2000), signal);
      },
      'log.openRepos': async (params) => {
        let streams = this.logStreams.get(endpoint);
        if (!streams) this.logStreams.set(endpoint, (streams = new Map()));
        const owned = streams;
        const { result, stream } = await openReposLog(
          { repo: (id) => registry.get(id), data: (id) => this.data(id), engine: this.logEngine },
          params,
          {
            onChunk: (chunk) => endpoint.emit('log.chunk', chunk),
            onEnd: (end) => {
              owned.delete(end.logId);
              endpoint.emit('log.end', end);
            },
          },
        );
        if (stream) owned.set(stream.logId, stream);
        return result;
      },
      'repo.refs': ({ repoId }) => this.data(repoId).refs({ shared: true }),
      'repo.workingTree': ({ repoId }) => this.data(repoId).workingTree({ shared: true }),
      'repo.worktreeChanges': ({ repoId }) => this.data(repoId).worktreeChanges({ shared: true }),
      'commit.details': ({ repoId, sha }) => this.data(repoId).commitDetails(sha),
      'commit.containedIn': ({ repoId, sha }, { signal }) =>
        this.data(repoId).refsContaining(checkObjectId(sha), signal),
      'reflog.list': ({ repoId, limit }) => readReflog(this.repo(repoId), checkCount(limit, 5000)),
      'worktree.list': ({ repoId }) => readWorktrees(this.repo(repoId)),
      'repo.remotes': ({ repoId }) => this.data(repoId).remotes({ shared: true }),
      'repo.codeHosts': ({ repoId }) => readCodeHosts(this.repo(repoId), platform.getSettings().links),
      'submodule.list': ({ repoId }) => readSubmodules(this.repo(repoId)),
      // Only a submodule or worktree of a repository already open: never any folder asked for.
      'repo.openLinked': async ({ repoId, path }) => {
        const folder = await linkedRepositoryFolder(this.repo(repoId), path);
        const linked =
          registry.all.find((repo) => paths.same(repo.root, folder)) ??
          (await platform.openRepository(folder));
        if (!linked || !registry.get(linked.id)) throw new Error(`Lanefold could not open ${folder}.`);
        registry.setActive(linked.id);
        return { repoId: linked.id };
      },
      'patch.text': async ({ repoId, shas }) =>
        (await formatPatches(this.repo(repoId), shas)).toString('utf8'),
      'patch.save': async ({ repoId, shas }) => {
        const repo = this.repo(repoId);
        const [content, name] = await Promise.all([formatPatches(repo, shas), patchFileName(repo, shas)]);
        return (await platform.saveFile(repo, name, content)) ?? null;
      },
      'host.pickFile': async ({ repoId, title }) =>
        (await platform.pickFile(this.repo(repoId), title)) ?? null,
      'host.openExternal': ({ url }) => platform.openExternal(checkWebUrl(url)),
      'stash.list': ({ repoId }) => this.data(repoId).stashList(),
      'stash.details': ({ repoId, sha }) => this.data(repoId).stashDetails(sha),
      'diff.files': ({ repoId, base, target }) =>
        this.data(repoId).diffFiles(base === undefined ? undefined : checkRev(base), checkRev(target)),
      'compare.summary': ({ repoId, a, b, mode }) =>
        this.data(repoId).compare(checkRev(a), checkRev(b), checkOneOf(mode, COMPARE_MODES, 'three-dot')),
      'compare.commits': ({ repoId, exclude, include, limit }) =>
        this.data(repoId).commitsBetween(checkRev(exclude), checkRev(include), checkCount(limit, 5000, 500)),
      'diff.open': ({ repoId, title, left, right }) =>
        platform.openDiff({ repo: this.repo(repoId), title, left, right }),
      'diff.openAll': ({ repoId, title, files, base, target }) =>
        platform.openMultiDiff({ repo: this.repo(repoId), title, files, base, target }),

      'op.plan': ({ repoId, operation }) => this.ops(repoId).plan(operation),
      'op.execute': ({ repoId, planId }) => this.operation(repoId, () => this.ops(repoId).execute(planId)),
      'op.undo': ({ repoId, entryId }) => this.operation(repoId, () => this.ops(repoId).undo(entryId)),
      'op.redo': ({ repoId }) => this.operation(repoId, () => this.ops(repoId).redo()),
      'op.undoInfo': ({ repoId }) => this.ops(repoId).undoInfo,

      'repo.opState': ({ repoId }) => this.ops(repoId).opState(),
      'rewrite.range': ({ repoId, base, onto }) =>
        this.ops(repoId).rewriteRange(base, onto === undefined ? undefined : checkRev(onto)),
      'rewrite.simulate': ({ repoId, base, onto, entries }, { signal }) =>
        this.ops(repoId).simulate(base, entries, signal, onto === undefined ? undefined : checkRev(onto)),
      // Taking a side rewrites the file only: it stays conflicted (restorable with its markers)
      // until marked resolved.
      'conflict.take': async ({ repoId, path, side }) => {
        if (side !== 'ours' && side !== 'theirs') throw new Error(`Unknown side: ${String(side)}`);
        const result = await this.ops(repoId).resolveConflict(path, side);
        this.changed(repoId);
        return result;
      },
      'conflict.mergeEditor': async ({ repoId, path, current, incoming }) => {
        const repo = this.repo(repoId);
        if ((await readSubmoduleConflicts(repo, [path])).length > 0)
          throw new Error(
            `${path} is a submodule: it has no text to merge. Record one side's commit for it.`,
          );
        const label = (side: unknown) => {
          const { title, detail } = (side ?? {}) as { title?: unknown; detail?: unknown };
          if (typeof title !== 'string' || (detail !== undefined && typeof detail !== 'string'))
            throw new Error('A side of the merge needs a title.');
          return { title: title.slice(0, 200), detail: detail?.slice(0, 500) };
        };
        const stages = await conflictStages(repo, path);
        // Both sides changed the file: compare them. Otherwise (one side deleted it) the file
        // itself shows what is left.
        if (
          stages.has(2) &&
          stages.has(3) &&
          (await platform.openMergeEditor({
            repo,
            path,
            current: label(current),
            incoming: label(incoming),
            hasBase: stages.has(1),
          }))
        )
          return { opened: 'mergeEditor' as const };
        await platform.openFile(repo, path);
        return { opened: 'file' as const };
      },
      'conflict.restore': async ({ repoId, path }) => {
        const result = await this.ops(repoId).resolveConflict(path, 'markers');
        this.changed(repoId);
        return result;
      },
      'conflict.recordSubmodule': async ({ repoId, path, side }) => {
        const result = await this.ops(repoId).recordSubmoduleConflict(path, side);
        this.changed(repoId);
        return result;
      },
      'conflict.markResolved': async ({ repoId, paths }) => {
        if (checkFilePaths(paths).length === 0) return;
        const repo = this.repo(repoId);
        await this.ops(repoId).enqueue(() =>
          repo.git(['add', ...filePaths(...paths)], { label: 'Mark resolved' }),
        );
        this.changed(repoId);
      },
      'index.stage': async ({ repoId, paths }) => {
        if (checkFilePaths(paths).length === 0) return;
        // -A: deleted files are staged as deletions, new files as additions.
        await this.indexChange(repoId, (repo) =>
          repo.git(['add', '-A', ...filePaths(...paths)], { label: 'Stage' }),
        );
      },
      'index.unstage': async ({ repoId, paths }) => {
        if (checkFilePaths(paths).length === 0) return;
        await this.indexChange(repoId, async (repo) => {
          const head = await repo.head();
          // A file staged and then edited again loses its staged version: keep a snapshot of it.
          const changes = await this.data(repoId).worktreeChanges();
          const edited = new Set(changes.unstaged.map((file) => file.path));
          if (changes.staged.some((file) => paths.includes(file.path) && edited.has(file.path)))
            await takeSnapshot(repo, 'unstage');
          // Without a first commit there is nothing to restore from: just drop them from the index.
          await repo.git(
            head.unborn
              ? ['rm', '--cached', '-r', '-q', ...filePaths(...paths)]
              : ['restore', '--staged', ...filePaths(...paths)],
            { label: 'Unstage' },
          );
        });
      },
      'diff.hunks': async ({ repoId, path, area }, { signal }) =>
        toFileHunks(
          await readFileDiff(
            this.repo(repoId),
            checkFilePath(path),
            checkArea(area, ['unstaged', 'staged', 'untracked']),
            { signal },
          ),
        ),
      // Patches are built here, from the backend's own diff: the webview names lines only.
      'index.stageLines': ({ repoId, path, area, fingerprint, selection }) => {
        const request = lineRequest(path, checkArea(area, ['unstaged', 'untracked']), fingerprint, selection);
        return this.indexChange(repoId, async (repo) =>
          applyToIndex(repo, await linePatchFor(repo, request, false), false, 'Stage lines'),
        );
      },
      'index.unstageLines': ({ repoId, path, area, fingerprint, selection }) => {
        const request = lineRequest(path, checkArea(area, ['staged']), fingerprint, selection);
        return this.indexChange(repoId, async (repo) => {
          const patch = await linePatchFor(repo, request, true);
          // Lines staged and then edited again lose their staged version: keep a snapshot (as Unstage does).
          if (await differsOnDisk(repo, request.path)) await takeSnapshot(repo, 'unstage');
          await applyToIndex(repo, patch, true, 'Unstage lines');
        });
      },
      'file.open': ({ repoId, path, rev }) => platform.openFile(this.repo(repoId), path, rev),
      'stats.get': (params, { signal }) =>
        this.stats.for(this.repo(params?.repoId)).get(checkStatsQuery(params), signal),
      'stats.countLines': ({ repoId, scope, lines, refresh }, { signal }) =>
        this.stats
          .for(this.repo(repoId))
          .countLines(checkStatsScope(scope), signal, refresh === true, checkLineCounting(lines)),
      'stats.languages': ({ repoId }, { signal }) => this.stats.for(this.repo(repoId)).languages(signal),
    };
  }

  dispose(): void {
    for (const endpoint of [...this.endpoints]) this.disconnect(endpoint);
    this.logEngine.dispose();
    for (const data of this.repoData.values()) data.dispose();
    this.repoData.clear();
    for (const ops of this.repoOps.values()) ops.dispose();
    this.repoOps.clear();
    this.stats.dispose();
    this.ready.clear();
    this.onDidConnectEmitter.dispose();
    this.store.dispose();
  }
}
