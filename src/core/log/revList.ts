import {
  isHideableRef,
  isLineRange,
  type HeadInfo,
  type LogOrder,
  type RefsSnapshot,
  type SearchQuery,
  type ViewConfig,
} from '../../shared/models';
import { OBJECT_ID } from '../../shared/oid';
import { assertRevision, pathspecs } from '../git/args';

export interface RevListQuery {
  /** Full git argument list, or `undefined` when the view has nothing to show (e.g. unborn HEAD). */
  readonly args: readonly string[] | undefined;
  /** Starting commits fed through `--stdin` (no command-line length limits). */
  readonly stdin?: string;
}

/**
 * Builds the `git rev-list --parents` invocation for a log view. Never uses `--all`: that would
 * pull in refs/stash, refs/prefetch/* (maintenance prefetch) and notes.
 *
 * `tips` (object IDs) replaces the ref options of the 'all' and 'local' scopes: the log can
 * start from the recently active refs, which lets git stream at once (see `preloadTips`).
 */
export function revListArgs(
  view: ViewConfig,
  head: HeadInfo,
  defaultOrder: LogOrder,
  options: { readonly tips?: readonly string[] } = {},
): RevListQuery {
  const order = view.order ?? defaultOrder;
  if (view.lines) return lineHistoryArgs(view, head, order);
  const args = ['rev-list', '--parents', order === 'date' ? '--date-order' : '--topo-order'];
  if (view.firstParent) args.push('--first-parent');
  if (view.noMerges) args.push('--no-merges');
  let stdin: string | undefined;
  const { tips } = options;
  if (tips && tips.length > 0 && (view.scope.type === 'all' || view.scope.type === 'local')) {
    for (const tip of tips) if (!OBJECT_ID.test(tip)) throw new Error(`Not an object ID: ${tip}`);
    args.push('--stdin');
    stdin = `${tips.join('\n')}\n`;
  } else {
    const scoped = scopeArgs(view, head);
    if (!scoped) return { args: undefined };
    args.push(...scoped);
  }
  // Path limiting: git rewrites parents so the graph of matching commits stays connected.
  if (view.paths && view.paths.length > 0) args.push(...pathspecs(...view.paths));
  return { args, stdin };
}

/**
 * Line history: `git log -L` prints the commits that changed the lines, with parents rewritten
 * to the previous such commit (`--parents`), in the same "commit parents…" lines as rev-list.
 */
function lineHistoryArgs(view: ViewConfig, head: HeadInfo, order: LogOrder): RevListQuery {
  const lines = view.lines;
  if (!isLineRange(lines)) throw new Error('Not a line range');
  // The lines are looked up in the starting commits: one line of history (HEAD by default).
  const scoped = scopeArgs(view.scope.type === 'refs' ? view : { ...view, scope: { type: 'head' } }, head);
  if (!scoped) return { args: undefined };
  const args = [
    'log',
    '--format=%H %P',
    '--parents',
    '-s',
    order === 'date' ? '--date-order' : '--topo-order',
  ];
  if (view.firstParent) args.push('--first-parent');
  if (view.noMerges) args.push('--no-merges');
  args.push(`-L${lines.start},${lines.end}:${lines.path}`, ...scoped);
  return { args };
}

/** Refs younger than this (relative to the newest) are part of the first, fast load. */
const PRELOAD_WINDOW_S = 60 * 24 * 3600;
const PRELOAD_MAX_TIPS = 64;

/**
 * Starting commits for a fast first load of an 'all' or 'local' view, or undefined when the
 * full query is just as fast.
 *
 * git's incremental `--topo-order` must first walk down to the oldest starting commit, so an
 * old tag or a stale branch delays the first line by a walk over most of the history. Starting
 * from HEAD and the recently active refs streams immediately; old refs are almost always
 * reachable from those and show up anyway. Any that are not are detected once the log has
 * loaded, and the view then reloads with every ref.
 */
export function preloadTips(view: ViewConfig, refs: RefsSnapshot): string[] | undefined {
  if ((view.scope.type !== 'all' && view.scope.type !== 'local') || view.lines) return undefined;
  const hidden = new Set(view.hidden);
  const extra = new Set(view.extra);
  const candidates = refs.refs.filter(
    (ref) =>
      (view.scope.type === 'all' || ref.kind === 'branch' || extra.has(ref.name)) && !hidden.has(ref.name),
  );
  if (candidates.length < 2 || candidates.some((ref) => ref.date === undefined)) return undefined;
  const newest = Math.max(...candidates.map((ref) => ref.date!));
  const recent = candidates
    .filter((ref) => ref.date! >= newest - PRELOAD_WINDOW_S)
    .sort((a, b) => b.date! - a.date!)
    .slice(0, PRELOAD_MAX_TIPS);
  if (recent.length === candidates.length) return undefined;
  const tips = new Set(recent.map((ref) => ref.target));
  if (refs.head.sha) tips.add(refs.head.sha);
  return [...tips];
}

/** Commits matching a search, newest first (`git log --format=%H …`), within a view's scope. */
export function searchArgs(
  view: ViewConfig,
  head: HeadInfo,
  query: SearchQuery,
  limit: number,
): string[][] | undefined {
  const scoped = scopeArgs(view, head);
  if (!scoped) return undefined;
  const base = ['log', '--format=%H', `--max-count=${limit}`, '--regexp-ignore-case', '--fixed-strings'];
  if (query.after) base.push(`--since=${query.after}`);
  if (query.before) base.push(`--until=${query.before}`);
  const tail = [...scoped, ...pathspecs(...(query.paths ?? view.paths ?? []))];
  // git ANDs --author with --grep, ORs repeated --grep (unless --all-match) and ORs repeated --author.
  const filters: string[] = [];
  if (query.author) filters.push(`--author=${query.author}`);
  if (query.message) filters.push(`--grep=${query.message}`);
  if (!query.text) return [[...base, ...filters, ...tail]];
  // Plain text matches the message or the author: two queries, merged by the caller.
  const variants = [[...base, '--all-match', ...filters, `--grep=${query.text}`, ...tail]];
  if (!query.author) variants.push([...base, ...filters, `--author=${query.text}`, ...tail]);
  return variants;
}

/** The refs a 'head' or 'local' view shows besides its own (full names, never options). */
function extraRefs(view: ViewConfig): string[] {
  return (view.extra ?? []).filter(isHideableRef);
}

/** `--exclude` options for the hidden refs under `prefix` (they apply to the next --branches etc.). */
function excludes(view: ViewConfig, prefix: string): string[] {
  return (view.hidden ?? [])
    .filter((name) => isHideableRef(name) && name.startsWith(prefix))
    .map((name) => `--exclude=${name.slice(prefix.length)}`);
}

/** The revision arguments selecting a view's refs, or undefined when nothing can match. */
function scopeArgs(view: ViewConfig, head: HeadInfo): string[] | undefined {
  const args: string[] = [];
  const revisions: string[] = [];
  const scope = view.scope;
  switch (scope.type) {
    case 'all':
      args.push(
        ...excludes(view, 'refs/heads/'),
        '--branches',
        ...excludes(view, 'refs/remotes/'),
        '--remotes',
        ...excludes(view, 'refs/tags/'),
        '--tags',
      );
      if (!head.unborn) revisions.push('HEAD');
      break;
    case 'local':
      args.push(...excludes(view, 'refs/heads/'), '--branches');
      if (!head.unborn) revisions.push('HEAD');
      revisions.push(...extraRefs(view));
      break;
    case 'head':
      if (!head.unborn) revisions.push('HEAD');
      revisions.push(...extraRefs(view));
      if (revisions.length === 0) return undefined;
      break;
    case 'refs':
      for (const ref of scope.refs) {
        if (ref.includes('*') || ref.includes('?')) {
          // Glob patterns go through --glob (an option, so it must precede --end-of-options).
          args.push(`--glob=${ref.startsWith('refs/') ? ref : `refs/heads/${ref}`}`);
        } else revisions.push(assertRevision(ref));
      }
      if (revisions.length === 0 && !args.some((a) => a.startsWith('--glob='))) return undefined;
      break;
  }
  if (revisions.length > 0) args.push('--end-of-options', ...revisions);
  return args;
}
