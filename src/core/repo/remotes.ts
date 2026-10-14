import type { RefInfo, RemoteInfo } from '../../shared/models';
import { redactCredentials } from '../../shared/shell';
import { validateRefName } from '../git/args';
import type { Repository } from './repository';

/** A remote as configured: its URLs exactly as written, credentials included (never for the webview). */
export interface ConfiguredRemote {
  readonly name: string;
  /** `remote.<name>.url`: git fetches from the first (and pushes there without a push URL). */
  readonly urls: readonly string[];
  /** `remote.<name>.pushurl`. */
  readonly pushUrls: readonly string[];
  /** `remote.<name>.fetch` refspecs (`+refs/heads/*:refs/remotes/<name>/*` unless changed). */
  readonly fetch: readonly string[];
}

/** `remote.<name>.<key>`: the name may itself hold dots, the key is the last part. */
const REMOTE_KEY = /^remote\.(.+)\.(url|pushurl|fetch)$/;

/**
 * Parses the remotes' names (`git remote`, one per line) and their settings (`git config -z
 * --get-regexp`: `key\nvalue` records, each ending in NUL), in the order of the names.
 */
export function parseRemotes(names: string, config: string): ConfiguredRemote[] {
  const remotes = new Map<string, { urls: string[]; pushUrls: string[]; fetch: string[] }>();
  for (const name of names.split(/\r?\n/)) if (name) remotes.set(name, { urls: [], pushUrls: [], fetch: [] });
  for (const record of config.split('\0')) {
    const newline = record.indexOf('\n');
    // A key without a value (no "=") sets nothing worth reading.
    if (newline < 0) continue;
    const match = REMOTE_KEY.exec(record.slice(0, newline));
    const remote = match ? remotes.get(match[1]!) : undefined;
    if (!match || !remote) continue;
    const value = record.slice(newline + 1);
    if (match[2] === 'url') remote.urls.push(value);
    else if (match[2] === 'pushurl') remote.pushUrls.push(value);
    else remote.fetch.push(value);
  }
  return [...remotes].map(([name, settings]) => ({ name, ...settings }));
}

/** A remote as the webview may see it: the credentials in its URLs hidden. */
export function describeRemote(remote: ConfiguredRemote): RemoteInfo {
  const url = remote.urls[0];
  // Pushes go to the push URL, else to the URL.
  const pushUrl = remote.pushUrls[0] ?? url;
  const shownUrl = url === undefined ? undefined : redactCredentials(url);
  const shownPushUrl = pushUrl === undefined ? undefined : redactCredentials(pushUrl);
  return {
    name: remote.name,
    url: shownUrl,
    pushUrl: pushUrl !== url ? shownPushUrl : undefined,
    credentialsHidden: shownUrl !== url || shownPushUrl !== pushUrl || undefined,
  };
}

/** The repository's remotes as configured, in `git remote`'s order (also those never fetched). */
export async function readConfiguredRemotes(repo: Repository): Promise<ConfiguredRemote[]> {
  const [names, config] = await Promise.all([
    repo.git(['remote'], { readOnly: true, background: true, label: 'Remotes' }),
    // Read-only commands keep no output for the console: the URLs' credentials stay here.
    repo.git(['config', '-z', '--get-regexp', '^remote\\..+\\.(url|pushurl|fetch)$'], {
      readOnly: true,
      background: true,
      label: 'Remote settings',
      // 1: none is set.
      okExitCodes: [0, 1],
    }),
  ]);
  return parseRemotes(names.stdout, config.stdout);
}

/** The repository's remotes for the webview: URLs without their credentials. */
export async function readRemotes(repo: Repository): Promise<RemoteInfo[]> {
  return (await readConfiguredRemotes(repo)).map(describeRemote);
}

/**
 * Why `name` cannot name a remote, or undefined. Its branches live under refs/remotes/<name>/, so
 * it follows the rules of ref names; and it must never read as an option (some git versions take
 * the arguments of `git remote rename` and `remove` as options, others never do: no `--` fits both).
 */
export function validateRemoteName(name: string): string | undefined {
  if (name.length === 0) return 'Enter a name for the remote.';
  if (name.startsWith('-')) return 'A remote name cannot start with “-”.';
  if (/\s/.test(name)) return 'A remote name cannot contain spaces.';
  const error = validateRefName(name);
  return error ? `${error.replace(/^Name\b/, 'A remote name')}.` : undefined;
}

/**
 * Why `url` cannot be a remote's URL, or undefined. Whatever git fetches from is fine (https://,
 * ssh://, git@host:path, file://, a folder); it must not read as an option nor hold control characters.
 */
export function validateRemoteUrl(url: string): string | undefined {
  if (url.trim().length === 0) return 'Enter the URL of the remote repository.';
  if (url.trimStart().startsWith('-')) return 'A URL cannot start with “-”.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url))
    return 'A URL cannot contain line breaks or other control characters.';
  return undefined;
}

/**
 * The ref a fetch refspec stores as `ref` (“refs/heads/x” for “refs/remotes/origin/x”, with git's
 * default “+refs/heads/*:refs/remotes/origin/*”), with how many characters of `ref` the refspec
 * names outright (the most specific of several refspecs wins); undefined when it does not store
 * `ref`.
 */
export function refspecSource(
  refspec: string,
  ref: string,
): { readonly source: string; readonly exact: number } | undefined {
  const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  const colon = spec.indexOf(':');
  // A negative refspec (“^refs/heads/x”) stores nothing, nor does one without a destination.
  if (spec.startsWith('^') || colon < 0) return undefined;
  const source = spec.slice(0, colon);
  const destination = spec.slice(colon + 1);
  const star = destination.indexOf('*');
  if (star < 0)
    return destination === ref && !source.includes('*') ? { source, exact: ref.length } : undefined;
  const prefix = destination.slice(0, star);
  const suffix = destination.slice(star + 1);
  const sourceStar = source.indexOf('*');
  if (
    sourceStar < 0 ||
    ref.length <= prefix.length + suffix.length ||
    !ref.startsWith(prefix) ||
    !ref.endsWith(suffix)
  )
    return undefined;
  const matched = ref.slice(prefix.length, ref.length - suffix.length);
  return {
    source: `${source.slice(0, sourceStar)}${matched}${source.slice(sourceStar + 1)}`,
    exact: prefix.length + suffix.length,
  };
}

/**
 * The remote, and the ref on it, that a remote branch here (“refs/remotes/origin/feature”) stands
 * for: read from the remotes' fetch settings, as git does (so a remote whose name holds “/” or
 * whose branches are stored elsewhere is no trouble). Undefined when no remote's settings store it.
 */
export function remoteBranchFor(
  tracking: string,
  remotes: readonly ConfiguredRemote[],
): { readonly remote: string; readonly ref: string } | undefined {
  let best: { remote: string; ref: string; exact: number } | undefined;
  for (const remote of remotes) {
    for (const refspec of remote.fetch) {
      const stored = refspecSource(refspec, tracking);
      if (stored && (!best || stored.exact > best.exact))
        best = { remote: remote.name, ref: stored.source, exact: stored.exact };
    }
  }
  return best && { remote: best.remote, ref: best.ref };
}

/** A local branch whose upstream is a branch of a given remote. */
export interface TrackingBranch {
  readonly branch: string;
  /** Its upstream, e.g. "origin/main". */
  readonly upstream: string;
}

/** Local branches whose upstream is on `remote` (`branch.<name>.remote`), fetched or not. */
export async function branchesTracking(repo: Repository, remote: string): Promise<TrackingBranch[]> {
  const { stdout } = await repo.git(
    ['for-each-ref', '--format=%(refname)%00%(upstream:remotename)%00%(upstream)', 'refs/heads'],
    { readOnly: true, background: true, label: 'Upstreams' },
  );
  return stdout.split('\n').flatMap((line) => {
    const [ref, owner, upstream] = line.split('\0');
    if (!ref || owner !== remote) return [];
    return [
      {
        branch: ref.replace(/^refs\/heads\//, ''),
        upstream: upstream ? upstream.replace(/^refs\/remotes\//, '') : remote,
      },
    ];
  });
}

/**
 * The remote branches (full ref names) that go along when a remote is removed or renamed: those
 * under refs/remotes/<remote>/, but not those of another remote whose name nests in it ("team" and
 * "team/ci"). Symbolic refs (`origin/HEAD`) are not among `refs`.
 */
export function remoteBranchesOf(
  refs: readonly RefInfo[],
  remote: string,
  remotes: readonly string[],
): string[] {
  const prefix = `refs/remotes/${remote}/`;
  const nested = remotes
    .filter((other) => other !== remote && other.startsWith(`${remote}/`))
    .map((other) => `refs/remotes/${other}/`);
  return refs
    .filter(
      (ref) =>
        ref.kind === 'remote' &&
        ref.name.startsWith(prefix) &&
        !nested.some((other) => ref.name.startsWith(other)),
    )
    .map((ref) => ref.name);
}
