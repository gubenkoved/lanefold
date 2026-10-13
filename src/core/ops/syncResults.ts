/**
 * What fetch, pull and push did, in words. They move remote branches and tags, which the journal
 * (local branches only) does not compare: those are read before and after, cheaply (names and
 * values, no objects opened). And why talking to a remote failed, plainly.
 */

import type { Operation, OperationPlan, RefState } from '../../shared/operations';
import type { GitError } from '../git/errors';
import { remoteNames } from '../git/queries';
import type { Repository } from '../repo/repository';
import { plural } from '../util/wording';

/** Remote branches and tags by full name, with the object each points to. */
export type SyncRefs = ReadonlyMap<string, string>;

const SYNC_KINDS: ReadonlySet<Operation['kind']> = new Set([
  'fetch',
  'pull',
  'push',
  'pushTag',
  'deleteRemoteTag',
]);

/** Operations that talk to a remote (their results are worded here). */
export function isSyncOperation(operation: Operation): boolean {
  return SYNC_KINDS.has(operation.kind);
}

export async function readSyncRefs(repo: Repository): Promise<SyncRefs> {
  const { stdout } = await repo.git(
    ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/remotes', 'refs/tags'],
    { readOnly: true, background: true, label: 'Remote branches and tags' },
  );
  const refs = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const [name, object, symref] = line.split('\0');
    // Symbolic refs (origin/HEAD) only follow the others.
    if (name && object && !symref) refs.set(name, object);
  }
  return refs;
}

/** How the refs under a prefix moved (full names). */
export interface RefMoves {
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
}

/** The refs under `prefix`, but none under `skip` (a remote nested in the name), that came, moved or went. */
export function refMoves(
  before: SyncRefs,
  after: SyncRefs,
  prefix: string,
  skip: readonly string[] = [],
): RefMoves {
  const mine = (name: string) => name.startsWith(prefix) && !skip.some((other) => name.startsWith(other));
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const [name, object] of after) {
    if (!mine(name)) continue;
    const was = before.get(name);
    if (was === undefined) added.push(name);
    else if (was !== object) updated.push(name);
  }
  for (const name of before.keys()) if (mine(name) && !after.has(name)) removed.push(name);
  return { added, updated, removed };
}

/**
 * "5 new branches, 2 updated, 1 removed (14 new commits)": the first part names what it counts.
 * Empty when nothing moved.
 */
export function describeMoves(moves: RefMoves, commits: number): string {
  const parts: string[] = [];
  const { added, updated, removed } = moves;
  if (added.length > 0) parts.push(plural(added.length, 'new branch', 'new branches'));
  if (updated.length > 0)
    parts.push(
      parts.length > 0
        ? `${updated.length} updated`
        : `${plural(updated.length, 'branch', 'branches')} updated`,
    );
  if (removed.length > 0)
    parts.push(
      parts.length > 0
        ? `${removed.length} removed`
        : `${plural(removed.length, 'branch', 'branches')} removed`,
    );
  if (parts.length === 0) return '';
  return `${parts.join(', ')}${commits > 0 ? ` (${plural(commits, 'new commit')})` : ''}`;
}

/** Commits reachable from `include` but from none of `exclude` (and, with `branches`, no local branch). */
async function countCommits(
  repo: Repository,
  include: readonly string[],
  exclude: Iterable<string>,
  branches = false,
): Promise<number> {
  if (include.length === 0) return 0;
  // Read from stdin they count as given: the --not of the command line is not theirs.
  const result = await repo.git(
    ['rev-list', '--count', '--stdin', ...(branches ? ['--not', '--branches'] : [])],
    {
      readOnly: true,
      background: true,
      label: 'Count commits',
      stdin: `${[...include, ...[...exclude].map((sha) => `^${sha}`)].join('\n')}\n`,
      okExitCodes: [0, 128],
    },
  );
  return result.exitCode === 0 ? Number(result.stdout.trim()) || 0 : 0;
}

/** The remote branches a fetch brought, per remote, and the tags. */
async function fetchMessage(
  repo: Repository,
  plan: OperationPlan,
  before: SyncRefs,
  after: SyncRefs,
): Promise<string> {
  // The plan fetches one remote (named last) or every one (--all).
  const target = plan.commands[0]?.args.at(-1);
  const one = target && target !== '--all' ? target : undefined;
  const remotes = one ? [one] : await remoteNames(repo);
  const changed: string[] = [];
  for (const remote of remotes) {
    const nested = remotes
      .filter((other) => other !== remote && other.startsWith(`${remote}/`))
      .map((other) => `refs/remotes/${other}/`);
    const moves = refMoves(before, after, `refs/remotes/${remote}/`, nested);
    const tips = [...moves.added, ...moves.updated].map((name) => after.get(name)!);
    const said = describeMoves(moves, await countCommits(repo, tips, before.values(), true));
    if (said) changed.push(`${remote}: ${said}`);
  }
  const tags = refMoves(before, after, 'refs/tags/').added.length;
  if (changed.length > 0)
    return `Fetched ${changed.join('; ')}.${tags > 0 ? ` ${plural(tags, 'new tag')}.` : ''}`;
  if (tags > 0) return `Fetched ${plural(tags, 'new tag')}${one ? ` from ${one}` : ''}.`;
  if (!one) return 'Every remote is up to date.';
  const empty = ![...after.keys()].some((name) => name.startsWith(`refs/remotes/${one}/`));
  return empty ? `${one} has no branches yet.` : `${one} is up to date.`;
}

/** Where a push went and how many commits it took (from the remote branch git updates as it pushes). */
async function pushMessage(
  repo: Repository,
  plan: OperationPlan,
  before: SyncRefs,
  after: SyncRefs,
): Promise<string | undefined> {
  // The plan's push ends with the remote and `branch` or `branch:target`.
  const args = plan.commands[0]?.args ?? [];
  const remote = args.at(-2);
  const spec = args.at(-1);
  if (!remote || !spec) return undefined;
  const [branch = spec, target = branch] = spec.split(':');
  const where = target === branch ? remote : `${remote}/${target}`;
  const ref = `refs/remotes/${remote}/${target}`;
  const was = before.get(ref);
  const now = after.get(ref);
  // A remote without fetch settings keeps no remote branch for it: nothing more to tell.
  if (now === undefined) return `Pushed ${branch} to ${where}.`;
  if (now === was)
    return plan.operation.kind === 'push' && plan.operation.tags
      ? `${branch} was already on ${where}; git pushed the annotated tags it lacked.`
      : `Everything was already on ${where}.`;
  if (was === undefined) {
    const remoteTips = [...before].filter(([name]) => name.startsWith('refs/remotes/')).map(([, sha]) => sha);
    const commits = await countCommits(repo, [now], remoteTips);
    return `Published ${branch} to ${where}${commits > 0 ? ` (${plural(commits, 'commit')})` : ''}.`;
  }
  const [pushed, dropped] = await Promise.all([
    countCommits(repo, [now], [was]),
    countCommits(repo, [was], [now]),
  ]);
  return dropped > 0
    ? `Replaced ${remote}/${target} with ${branch}: ${plural(pushed, 'commit')} pushed, ${plural(dropped, 'commit')} taken off the remote.`
    : `Pushed ${branch} to ${where} (${plural(pushed, 'commit')}).`;
}

/** What a pull brought into the branch, and how: fast-forward, merge or rebase (read from the result). */
async function pullMessage(
  repo: Repository,
  stateBefore: RefState,
  stateAfter: RefState,
  after: SyncRefs,
): Promise<string | undefined> {
  const branch = stateBefore.branch;
  if (!branch) return undefined;
  const ref = `refs/heads/${branch}`;
  const was = stateBefore.refs[ref];
  const now = stateAfter.refs[ref];
  const { stdout } = await repo.git(['for-each-ref', '--format=%(upstream)%00%(upstream:short)', ref], {
    readOnly: true,
    background: true,
    label: 'Upstream',
  });
  const [upstreamRef, upstream] = stdout.trim().split('\0');
  const incoming = upstreamRef ? after.get(upstreamRef) : undefined;
  if (!was || !now || !incoming || !upstream) return undefined;
  if (now === was) return `${branch} is up to date with ${upstream}.`;
  const brought = await countCommits(repo, [incoming], [was]);
  if (now === incoming) return `Fast-forwarded ${branch} by ${plural(brought, 'commit')} from ${upstream}.`;
  const parents = await repo.git(['rev-list', '--parents', '-n', '1', '--end-of-options', now], {
    readOnly: true,
    background: true,
    label: 'Parents',
  });
  if (parents.stdout.trim().split(' ').slice(2).includes(incoming))
    return `Merged ${plural(brought, 'commit')} from ${upstream} into ${branch}.`;
  const replayed = await countCommits(repo, [now], [incoming]);
  return `Rebased ${plural(replayed, 'local commit')} of ${branch} onto ${brought > 0 ? `${plural(brought, 'new commit')} from ` : ''}${upstream}.`;
}

/** A tag sent to, or taken off, a remote (named in the plan's push). */
function tagMessage(plan: OperationPlan): string | undefined {
  const operation = plan.operation;
  const remote = plan.commands[0]?.args[1];
  if (!remote) return undefined;
  if (operation.kind === 'pushTag')
    return operation.name ? `${operation.name} is on ${remote} now.` : `Every local tag is on ${remote} now.`;
  if (operation.kind === 'deleteRemoteTag')
    return `${operation.name} is gone from ${remote}; your local tag stays.`;
  return undefined;
}

/**
 * What a fetch, pull or push that ran did, in words; `before` are the remote branches and tags
 * read before it ran, `stateBefore`/`stateAfter` the local branches.
 */
export async function syncMessage(
  repo: Repository,
  plan: OperationPlan,
  before: SyncRefs,
  stateBefore: RefState,
  stateAfter: RefState,
): Promise<string | undefined> {
  switch (plan.operation.kind) {
    case 'fetch':
      return fetchMessage(repo, plan, before, await readSyncRefs(repo));
    case 'push':
      return pushMessage(repo, plan, before, await readSyncRefs(repo));
    case 'pull':
      return pullMessage(repo, stateBefore, stateAfter, await readSyncRefs(repo));
    case 'pushTag':
    case 'deleteRemoteTag':
      return tagMessage(plan);
    default:
      return undefined;
  }
}

/** Commands that talk to a remote. */
const REMOTE_COMMANDS = new Set(['fetch', 'pull', 'push', 'ls-remote', 'clone', 'submodule']);

/** The host a failure names: in a URL (its credentials already hidden), or in ssh's own words. */
function hostIn(text: string): string | undefined {
  return (
    /\b(?:https?|ssh|git|ftps?):\/\/(?:[^@/\s']*@)?([^/:\s']+)/.exec(text)?.[1] ??
    /ssh: (?:connect to host|Could not resolve hostname) ([^\s:]+)/.exec(text)?.[1] ??
    /[\w.+-]+@([\w.-]+): Permission denied/.exec(text)?.[1] ??
    /[Hh]ost key (?:is known )?for ([\w.-]+)/.exec(text)?.[1] ??
    /Could not resolve host: ([^\s']+)/.exec(text)?.[1]
  );
}

/** Why talking to a remote failed: in a few words (for a list), and in a sentence. */
interface Cause {
  readonly short: string;
  readonly long: string;
}

/** What stood in the way, from git's (or ssh's) words; undefined when git's own line says it best. */
function causeOf(text: string): Cause | undefined {
  const host = hostIn(text);
  const at = host ?? 'the remote';
  const At = host ?? 'The remote';
  if (/unable to read askpass response/.test(text))
    return { short: 'signing in was cancelled', long: `Signing in to ${at} was cancelled.` };
  if (/could not read (?:Username|Password) for/.test(text))
    return {
      short: `${at} wants a user name and password`,
      long: `${At} asks for a user name and password (or a token), and git could not ask you for them here. A credential helper can provide them.`,
    };
  if (/Authentication failed for/.test(text))
    return {
      short: `${at} did not accept the user name and password`,
      long: `Signing in to ${at} failed: the user name and password (or token) were not accepted.`,
    };
  if (/Permission denied \(publickey/.test(text))
    return { short: `${at} did not accept your SSH key`, long: `${At} did not accept your SSH key.` };
  if (/Host key verification failed/.test(text))
    return {
      short: `the SSH host key of ${at} is unknown or changed`,
      long: `The SSH host key of ${at} is unknown or has changed, so git did not connect.`,
    };
  if (/Could not resolve host|Could not resolve hostname|Temporary failure in name resolution/.test(text))
    return {
      short: `${at} cannot be reached`,
      long: `Could not reach ${at}: there is no such host. Check the URL and your connection.`,
    };
  if (
    /Failed to connect to|Connection refused|Connection timed out|Operation timed out|Network is unreachable|No route to host|Couldn't connect to server/.test(
      text,
    )
  )
    return {
      short: `${at} does not answer`,
      long: `Could not connect to ${at}. Check the URL and your connection.`,
    };
  const missing = /'(.+)' does not appear to be a git repository/.exec(text);
  if (missing)
    return { short: 'no git repository there', long: `There is no git repository at ${missing[1]}.` };
  const notFound = /repository '(.+?)\/?' not found/.exec(text);
  if (notFound)
    return {
      short: 'no repository there',
      long: `There is no repository at ${notFound[1]}, or you have no access to it.`,
    };
  return undefined;
}

/** "a", "a and b", "a, b and c". */
function listOf(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * The remotes a `git fetch --all` could not fetch, each with why: git goes on to the next remote,
 * printing "Fetching <name>" before each and "error: could not fetch <name>" after a failure.
 */
function failedFetches(text: string): string[] {
  const failed: string[] = [];
  let segment: string[] = [];
  for (const line of text.split('\n')) {
    const name = /^error: [Cc]ould not fetch (\S+)/.exec(line)?.[1];
    if (name) {
      const cause = causeOf(segment.join('\n'));
      failed.push(cause ? `${name} (${cause.short})` : name);
      segment = [];
    } else if (/^Fetching \S+$/.test(line)) segment = [];
    else segment.push(line);
  }
  return failed;
}

/**
 * Why talking to a remote failed, in plain words: it could not be reached, signing in was
 * cancelled or refused, there is no repository there. Undefined when git's own line says it best.
 */
export function describeRemoteFailure(error: GitError): string | undefined {
  if (!REMOTE_COMMANDS.has(error.args[0] ?? '')) return undefined;
  const failed = error.args[0] === 'fetch' && error.args.includes('--all') ? failedFetches(error.stderr) : [];
  if (failed.length > 0) return `Could not fetch ${listOf(failed)}.`;
  return causeOf(error.stderr)?.long;
}

/**
 * What a fetch of every remote brought from those it reached, when others failed ("Fetched
 * origin: …"); undefined when it brought nothing.
 */
export async function fetchedDespiteFailure(
  repo: Repository,
  plan: OperationPlan,
  before: SyncRefs,
): Promise<string | undefined> {
  if (plan.operation.kind !== 'fetch') return undefined;
  const said = await fetchMessage(repo, plan, before, await readSyncRefs(repo));
  return said.startsWith('Fetched') ? said : undefined;
}
