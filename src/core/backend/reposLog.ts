import type { TopologyChunk } from '../../shared/graph/topology';
import type { HeadInfo, RefsSnapshot, ViewConfig } from '../../shared/models';
import { OBJECT_ID } from '../../shared/oid';
import type { LogEnd, ReposLogOpenResult, ReposLogSource } from '../../shared/protocol';
import { objectStores } from '../../shared/repoGroups';
import type { LogEngine, LogStream, MergedSource } from '../log/logEngine';
import { preloadTips, revListArgs } from '../log/revList';
import type { RepoData } from '../repo/repoData';
import type { Repository } from '../repo/repository';

/** Most repositories one log merges. */
const MAX_REPOS = 256;

const NO_REFS: RefsSnapshot = { refs: [], head: { detached: false, unborn: true } };

export interface ReposLogHost {
  /** An open repository (undefined once it was closed). */
  readonly repo: (repoId: string) => Repository | undefined;
  readonly data: (repoId: string) => RepoData;
  readonly engine: LogEngine;
}

export interface ReposLogEvents {
  onChunk(chunk: TopologyChunk): void;
  onEnd(end: LogEnd): void;
}

/** The options a log of several repositories supports, from the webview's (untrusted) view. */
export function reposLogView(view: unknown): ViewConfig {
  const { scope, firstParent, noMerges } = (view ?? {}) as Record<string, unknown>;
  const type = (scope as { type?: unknown } | null | undefined)?.type;
  if (type !== 'all' && type !== 'local' && type !== 'head')
    throw new Error('A log of several repositories shows all, local or current branches.');
  return { scope: { type }, order: 'date', firstParent: firstParent === true, noMerges: noMerges === true };
}

/**
 * One repository's rev-list in a merged log: the view's scope by commit date, each commit with
 * its timestamp (what the logs are merged by). `heads`: more commits to start from (the HEADs
 * of its other worktrees).
 */
export function mergedRevList(
  view: ViewConfig,
  refs: RefsSnapshot,
  heads: readonly string[],
  complete: boolean,
): { args: string[]; stdin?: string; partial: boolean } | undefined {
  const starts = heads.filter((sha) => OBJECT_ID.test(sha));
  const preload = complete ? undefined : preloadTips(view, refs);
  const tips = preload && [...new Set([...preload, ...starts])];
  const query = revListArgs(view, refs.head, 'date', { tips });
  let args = query.args && [...query.args];
  let stdin = query.stdin;
  if (!tips && starts.length > 0) {
    args ??= [
      'rev-list',
      '--parents',
      '--date-order',
      ...(view.firstParent ? ['--first-parent'] : []),
      ...(view.noMerges ? ['--no-merges'] : []),
    ];
    // An option, so it goes before --end-of-options.
    args.splice(1, 0, '--stdin');
    stdin = `${starts.join('\n')}\n`;
  }
  if (!args) return undefined;
  args.splice(1, 0, '--timestamp');
  return { args, stdin, partial: !!tips };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Opens the log of several repositories: one rev-list per object store (linked worktrees of a
 * repository share theirs and are read once, through the first of them), merged by commit date
 * into one stream of chunks whose rows name their repository. Repositories that cannot be read
 * are listed with the reason and left out; the others still load.
 */
export async function openReposLog(
  host: ReposLogHost,
  params: { readonly repoIds?: unknown; readonly view?: unknown; readonly complete?: unknown },
  events: ReposLogEvents,
): Promise<{ readonly result: ReposLogOpenResult; readonly stream?: LogStream }> {
  const view = reposLogView(params.view);
  if (!Array.isArray(params.repoIds)) throw new Error('Expected a list of repositories.');
  const repos: Repository[] = [];
  for (const id of new Set<unknown>(params.repoIds)) {
    // A repository closed since the view asked is left out.
    const repo = typeof id === 'string' ? host.repo(id) : undefined;
    if (repo) repos.push(repo);
  }
  if (repos.length > MAX_REPOS) throw new Error(`A log can show at most ${MAX_REPOS} repositories.`);
  const complete = params.complete === true;

  const stores = await Promise.all(
    objectStores(repos).map(async ([primary, ...worktrees]) => {
      const data = host.data(primary!.id);
      // Metadata requests follow right after the first rows.
      data.warmUp();
      try {
        const [refs, heads] = await Promise.all([
          data.refs({ shared: true }),
          Promise.all(worktrees.map((worktree) => worktree.head())),
        ]);
        return { primary: primary!, worktrees, refs, heads, error: undefined };
      } catch (error) {
        const heads: HeadInfo[] = worktrees.map(() => NO_REFS.head);
        return { primary: primary!, worktrees, refs: NO_REFS, heads, error: message(error) };
      }
    }),
  );

  // One log has one kind of object names: repositories with the other kind keep to their own log.
  const format = stores.find((store) => !store.error)?.primary.objectFormat ?? 'sha1';
  const streamed: { source: ReposLogSource; run: MergedSource }[] = [];
  const idle: ReposLogSource[] = [];
  let partial = false;
  for (const store of stores) {
    const error =
      store.error ??
      (store.primary.objectFormat !== format
        ? `Its commits have ${store.primary.objectFormat === 'sha256' ? 'SHA-256' : 'SHA-1'} names, unlike the other repositories: its history is in its own log.`
        : undefined);
    const source: ReposLogSource = {
      repoId: store.primary.id,
      worktrees: store.worktrees.map((worktree) => worktree.id),
      worktreeHeads: store.heads,
      refs: store.refs,
      error,
    };
    const heads = store.heads.flatMap((head) => (head.sha ? [head.sha] : []));
    const query = error ? undefined : mergedRevList(view, store.refs, heads, complete);
    if (!query) {
      idle.push(source);
      continue;
    }
    partial ||= query.partial;
    streamed.push({ source, run: { repo: store.primary, args: query.args, stdin: query.stdin } });
  }
  // Rows index this list: the streamed repositories come first, in the order asked for.
  const sources = [...streamed.map((entry) => entry.source), ...idle];
  const oidBytes = format === 'sha256' ? 32 : 20;
  if (streamed.length === 0) {
    const logId = -Date.now();
    queueMicrotask(() => events.onEnd({ logId, rowCount: 0, durationMs: 0 }));
    return { result: { logId, oidBytes, sources, empty: true } };
  }
  const stream = host.engine.openMerged(
    streamed.map((entry) => entry.run),
    oidBytes,
    {
      onChunk: (chunk) => events.onChunk(chunk),
      onEnd: (info) => events.onEnd({ logId: stream.logId, ...info }),
    },
  );
  return { result: { logId: stream.logId, oidBytes, sources, empty: false, partial }, stream };
}
