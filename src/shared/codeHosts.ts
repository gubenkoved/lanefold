/*
 * Links to where a repository is hosted (GitHub, GitLab, Gitea and Forgejo, Bitbucket, Azure
 * DevOps), read off its remotes' URLs: which host and repository each remote names, and the web
 * addresses of commits, files, branches, tags, comparisons and issues there.
 */

export type CodeHostKind = 'github' | 'gitlab' | 'gitea' | 'bitbucket' | 'bitbucketServer' | 'azure';

export const CODE_HOST_KINDS: readonly CodeHostKind[] = [
  'github',
  'gitlab',
  'gitea',
  'bitbucket',
  'bitbucketServer',
  'azure',
];

/** A remote's repository on a code host. */
export interface CodeHost {
  /** The remote's name. */
  readonly remote: string;
  readonly kind: CodeHostKind;
  /** The host as people call it: "GitHub", "GitLab", "Codeberg"… */
  readonly name: string;
  /** The repository's web page, e.g. "https://github.com/acme/aurora". */
  readonly url: string;
  /** The repository as the host names it, e.g. "acme/aurora". */
  readonly repository: string;
}

/**
 * A host Lanefold cannot tell by name, such as a self-hosted server (`lanefold.links.hosts`, by
 * the host name in remote URLs): its kind, and its web address when that is not the git host's.
 */
export type HostSetting =
  CodeHostKind | { readonly type: CodeHostKind; readonly url?: string; readonly name?: string };

/** An issue reference to link in messages, as on GitHub: "PROJ-" + `<num>` in `url`. */
export interface Autolink {
  readonly prefix: string;
  readonly url: string;
  /** `<num>` takes letters too, not only digits. */
  readonly alphanumeric?: boolean;
}

export interface LinkSettings {
  readonly hosts: Readonly<Record<string, HostSetting>>;
  readonly autolinks: readonly Autolink[];
}

export const DEFAULT_LINK_SETTINGS: LinkSettings = { hosts: {}, autolinks: [] };

/** `lanefold.links.*` as configured: what is not well-formed is left out. */
export function readLinkSettings(hosts: unknown, autolinks: unknown): LinkSettings {
  const isKind = (value: unknown): value is CodeHostKind =>
    typeof value === 'string' && (CODE_HOST_KINDS as readonly string[]).includes(value);
  const hostSettings: Record<string, HostSetting> = {};
  if (hosts && typeof hosts === 'object' && !Array.isArray(hosts)) {
    for (const [name, value] of Object.entries(hosts as Record<string, unknown>)) {
      if (isKind(value)) hostSettings[name.toLowerCase()] = value;
      else if (value && typeof value === 'object') {
        const { type, url, name: shown } = value as Record<string, unknown>;
        if (!isKind(type)) continue;
        hostSettings[name.toLowerCase()] = {
          type,
          url: typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined,
          name: typeof shown === 'string' && shown.trim() ? shown.trim() : undefined,
        };
      }
    }
  }
  const links = Array.isArray(autolinks)
    ? autolinks.flatMap((value: unknown): Autolink[] => {
        if (!value || typeof value !== 'object') return [];
        const { prefix, url, alphanumeric } = value as Record<string, unknown>;
        return typeof prefix === 'string' &&
          prefix.length > 0 &&
          typeof url === 'string' &&
          /^https?:\/\//i.test(url) &&
          url.includes('<num>')
          ? [{ prefix, url, alphanumeric: alphanumeric === true || undefined }]
          : [];
      })
    : [];
  return { hosts: hostSettings, autolinks: links };
}

// ---- remote URLs ----------------------------------------------------------------------------

/** Where a remote URL points: its host and the repository's path there (credentials left out). */
export interface RemoteAddress {
  /** How git reaches it; 'http' and 'https' are also how a browser does. */
  readonly scheme: 'https' | 'http' | 'ssh' | 'git';
  /** Lower case. */
  readonly host: string;
  readonly port?: number;
  /** Without leading or trailing slashes, nor ".git". */
  readonly path: string;
}

const SCHEMES: Readonly<Record<string, RemoteAddress['scheme']>> = {
  https: 'https',
  http: 'http',
  ssh: 'ssh',
  'git+ssh': 'ssh',
  'ssh+git': 'ssh',
  git: 'git',
};

function cleanPath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

/**
 * Parses a remote URL as git writes them: `https://host/path`, `ssh://user@host:port/path`,
 * `git://host/path` and the scp-like `user@host:path`. Local paths and `file://` URLs are not
 * on a host: undefined.
 */
export function parseRemoteUrl(url: string): RemoteAddress | undefined {
  const text = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme) {
    const kind = SCHEMES[scheme[1]!.toLowerCase()];
    if (!kind) return undefined;
    const rest = text.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const match = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d*))?$/.exec(hostPort);
    if (!match) return undefined;
    const port = match[2] ? Number(match[2]) : undefined;
    return {
      scheme: kind,
      host: match[1]!.toLowerCase(),
      ...(port === undefined ? {} : { port }),
      path: cleanPath(slash < 0 ? '' : rest.slice(slash + 1)),
    };
  }
  // scp-like: a colon before any slash. One letter before it is a Windows drive, not a host.
  const scp = /^(?:[^@/\\]+@)?(\[[^\]]+\]|[^:/\\[\]@]{2,}):(.*)$/.exec(text);
  if (!scp || scp[2]!.startsWith('//')) return undefined;
  return { scheme: 'ssh', host: scp[1]!.toLowerCase(), path: cleanPath(scp[2]!) };
}

/** `url.<base>.insteadOf <prefix>`: a URL starting with `prefix` is fetched from `base` instead. */
export interface UrlRewrite {
  readonly base: string;
  readonly prefix: string;
}

/** Applies git's `insteadOf` rewrites to a URL, as git does: the longest matching prefix wins. */
export function rewriteUrl(url: string, rewrites: readonly UrlRewrite[]): string {
  let best: UrlRewrite | undefined;
  for (const rewrite of rewrites)
    if (url.startsWith(rewrite.prefix) && (!best || rewrite.prefix.length > best.prefix.length))
      best = rewrite;
  return best ? best.base + url.slice(best.prefix.length) : url;
}

// ---- hosts ----------------------------------------------------------------------------------

/** Hosts known by name: their kind and, where git and the web use different names, the web's. */
const KNOWN_HOSTS: Readonly<Record<string, { kind: CodeHostKind; web?: string; name?: string }>> = {
  'github.com': { kind: 'github' },
  'www.github.com': { kind: 'github', web: 'github.com' },
  'ssh.github.com': { kind: 'github', web: 'github.com' },
  'gitlab.com': { kind: 'gitlab' },
  'altssh.gitlab.com': { kind: 'gitlab', web: 'gitlab.com' },
  'bitbucket.org': { kind: 'bitbucket' },
  'altssh.bitbucket.org': { kind: 'bitbucket', web: 'bitbucket.org' },
  'codeberg.org': { kind: 'gitea', name: 'Codeberg' },
  'gitea.com': { kind: 'gitea' },
  'dev.azure.com': { kind: 'azure' },
  'ssh.dev.azure.com': { kind: 'azure' },
  'vs-ssh.visualstudio.com': { kind: 'azure' },
};

const KIND_NAMES: Readonly<Record<CodeHostKind, string>> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Gitea',
  bitbucket: 'Bitbucket',
  bitbucketServer: 'Bitbucket',
  azure: 'Azure DevOps',
};

/**
 * What kind of host serves `host` (the host name in a remote URL): set in the settings, known by
 * name, or told by its name or path (`github.example.com`, `…/_git/…` for Azure DevOps Server).
 * Undefined when nothing tells: no links are better than wrong ones.
 */
function kindOf(host: string, path: string, settings: LinkSettings['hosts']): CodeHostKind | undefined {
  const set = settings[host];
  if (set) return typeof set === 'string' ? set : set.type;
  const known = KNOWN_HOSTS[host];
  if (known) return known.kind;
  if (host.endsWith('.visualstudio.com')) return 'azure';
  if (host.endsWith('.ghe.com')) return 'github';
  if (path.split('/').includes('_git')) return 'azure';
  const labels = host.split('.');
  if (labels.some((label) => label.startsWith('github'))) return 'github';
  if (labels.some((label) => label.startsWith('gitlab'))) return 'gitlab';
  if (labels.some((label) => label.startsWith('gitea') || label.startsWith('forgejo'))) return 'gitea';
  if (labels.some((label) => label.startsWith('bitbucket'))) return 'bitbucketServer';
  return undefined;
}

/**
 * Whether a host name is known as it is (set in the settings, or a public host). Over SSH, one
 * that is not may be an alias of the SSH configuration (`github-work` for github.com): it is
 * looked up there before anything is read off its name.
 */
export function isKnownHost(host: string, settings: LinkSettings['hosts']): boolean {
  return (
    settings[host] !== undefined ||
    KNOWN_HOSTS[host] !== undefined ||
    host.endsWith('.visualstudio.com') ||
    host.endsWith('.ghe.com')
  );
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The code host and repository a remote URL names, or undefined (a local path, a host Lanefold
 * cannot tell, a path that names no repository there).
 */
export function codeHostOf(
  remote: string,
  address: RemoteAddress,
  settings: LinkSettings['hosts'] = {},
): CodeHost | undefined {
  const kind = kindOf(address.host, address.path, settings);
  if (!kind) return undefined;
  const set = settings[address.host];
  const setUrl = typeof set === 'object' ? set.url?.replace(/\/+$/, '') : undefined;
  const known = KNOWN_HOSTS[address.host];
  const web = known?.web ?? address.host;
  // A browser reaches an http(s) remote where git does; SSH and git:// servers serve the web on https.
  const browsable = address.scheme === 'https' || address.scheme === 'http';
  const origin =
    setUrl ??
    `${address.scheme === 'http' ? 'http' : 'https'}://${web}${browsable && address.port ? `:${address.port}` : ''}`;
  const name =
    (typeof set === 'object' ? set.name : undefined) ??
    known?.name ??
    (address.host.split('.').some((label) => label.startsWith('forgejo')) ? 'Forgejo' : KIND_NAMES[kind]);
  const parts = address.path.split('/').filter(Boolean);
  const host = (url: string, repository: string): CodeHost => ({
    remote,
    kind,
    name,
    url,
    repository: safeDecode(repository),
  });

  if (kind === 'azure') {
    // https://dev.azure.com/org/project/_git/repo (or org/_git/repo: the project's own repository),
    // https://org.visualstudio.com/[DefaultCollection/]project/_git/repo, and over SSH
    // v3/org/project/repo; Azure DevOps Server: https://server/[tfs/]collection/project/_git/repo.
    if (parts[0] === 'v3' && parts.length === 4) {
      const [, org, project, repo] = parts as [string, string, string, string];
      const url = setUrl
        ? `${setUrl}/${project}/_git/${repo}`
        : `https://dev.azure.com/${org}/${project}/_git/${repo}`;
      return host(url, `${org}/${project}/${repo}`);
    }
    const at = parts.indexOf('_git');
    if (at < 1 || at !== parts.length - 2) return undefined;
    const shown = [...parts.slice(0, at), parts[at + 1]!];
    if (address.host.endsWith('.visualstudio.com')) shown.unshift(address.host.split('.')[0]!);
    return host(
      `${origin}/${parts.join('/')}`,
      shown.filter((part) => part !== 'DefaultCollection').join('/'),
    );
  }
  if (kind === 'bitbucketServer') {
    // Over https: [context/]scm/PROJECT/repo (or scm/~user/repo); over SSH: PROJECT/repo.
    const scm = parts.indexOf('scm');
    const context = browsable && scm > 0 ? parts.slice(0, scm) : [];
    const rest = scm >= 0 ? parts.slice(scm + 1) : parts;
    if (rest.length !== 2) return undefined;
    const [project, repo] = rest as [string, string];
    const base = [origin, ...context].join('/');
    return project.startsWith('~')
      ? host(`${base}/users/${project.slice(1)}/repos/${repo}`, `${project}/${repo}`)
      : host(`${base}/projects/${project.toUpperCase()}/repos/${repo}`, `${project.toUpperCase()}/${repo}`);
  }
  // GitHub, Gitea and Bitbucket name a repository by owner and name; GitLab nests groups.
  if (parts.length < 2 || (kind !== 'gitlab' && parts.length !== 2)) return undefined;
  return host(`${origin}/${parts.join('/')}`, parts.join('/'));
}

/**
 * Hosts in the order links prefer them: `upstream` first (in a fork it is the original
 * repository, where commits that made it there are at home), then `origin`, then the rest as
 * configured.
 */
export function preferHosts(hosts: readonly CodeHost[]): CodeHost[] {
  const rank = (host: CodeHost) => (host.remote === 'upstream' ? 0 : host.remote === 'origin' ? 1 : 2);
  return hosts
    .map((host, index) => ({ host, index }))
    .sort((a, b) => rank(a.host) - rank(b.host) || a.index - b.index)
    .map(({ host }) => host);
}

// ---- web addresses --------------------------------------------------------------------------

/** What a link shows: a commit, a file (at a commit, maybe some of its lines), a ref, a comparison. */
export type LinkTarget =
  | { readonly kind: 'commit'; readonly sha: string }
  | {
      readonly kind: 'file';
      readonly sha: string;
      readonly path: string;
      /** 1-based, inclusive. */
      readonly lines?: { readonly start: number; readonly end: number };
    }
  | { readonly kind: 'branch'; readonly name: string }
  | { readonly kind: 'tag'; readonly name: string }
  | { readonly kind: 'compare'; readonly from: string; readonly to: string };

/** A path or ref name in a URL path: each part encoded, the slashes kept. */
function segments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Files hosts render (Markdown and the like) rather than show as text: lines need the source view. */
const RENDERED =
  /\.(md|markdown|mdown|mkdn|mkd|rst|adoc|asciidoc|org|textile|rdoc|creole|mediawiki|wiki|pod|ipynb|csv|tsv|svg|geojson|topojson)$/i;

/** The web address of `target` on `host`; undefined where the host has no page for it. */
export function linkUrl(host: CodeHost, target: LinkTarget): string | undefined {
  const { url, kind } = host;
  switch (target.kind) {
    case 'commit':
      if (kind === 'gitlab') return `${url}/-/commit/${target.sha}`;
      if (kind === 'bitbucket' || kind === 'bitbucketServer') return `${url}/commits/${target.sha}`;
      return `${url}/commit/${target.sha}`;
    case 'file': {
      const { sha, path, lines } = target;
      const start = lines?.start;
      const end = lines && lines.end > lines.start ? lines.end : undefined;
      const source = lines && RENDERED.test(path);
      switch (kind) {
        case 'github':
          return `${url}/blob/${sha}/${segments(path)}${source ? '?plain=1' : ''}${start ? `#L${start}${end ? `-L${end}` : ''}` : ''}`;
        case 'gitlab':
          return `${url}/-/blob/${sha}/${segments(path)}${source ? '?plain=1' : ''}${start ? `#L${start}${end ? `-${end}` : ''}` : ''}`;
        case 'gitea':
          return `${url}/src/commit/${sha}/${segments(path)}${source ? '?display=source' : ''}${start ? `#L${start}${end ? `-L${end}` : ''}` : ''}`;
        case 'bitbucket':
          return `${url}/src/${sha}/${segments(path)}${start ? `#lines-${start}${end ? `:${end}` : ''}` : ''}`;
        case 'bitbucketServer':
          return `${url}/browse/${segments(path)}?at=${sha}${start ? `#${start}${end ? `-${end}` : ''}` : ''}`;
        case 'azure': {
          // The selection ends before column 1 of the line after the last.
          const range = start
            ? `&line=${start}&lineEnd=${(end ?? start) + 1}&lineStartColumn=1&lineEndColumn=1&lineStyle=plain`
            : '';
          return `${url}?path=${encodeURIComponent(`/${path}`)}&version=GC${sha}${range}&_a=contents`;
        }
      }
      return undefined;
    }
    case 'branch':
      switch (kind) {
        case 'github':
          return `${url}/tree/${segments(target.name)}`;
        case 'gitlab':
          return `${url}/-/tree/${segments(target.name)}`;
        case 'gitea':
          return `${url}/src/branch/${segments(target.name)}`;
        case 'bitbucket':
          return `${url}/branch/${segments(target.name)}`;
        case 'bitbucketServer':
          return `${url}/browse?at=${segments(`refs/heads/${target.name}`)}`;
        case 'azure':
          return `${url}?version=GB${encodeURIComponent(target.name)}`;
      }
      return undefined;
    case 'tag':
      switch (kind) {
        case 'github':
          return `${url}/tree/${segments(target.name)}`;
        case 'gitlab':
          return `${url}/-/tags/${segments(target.name)}`;
        case 'gitea':
          return `${url}/src/tag/${segments(target.name)}`;
        case 'bitbucket':
          return `${url}/src/${segments(target.name)}`;
        case 'bitbucketServer':
          return `${url}/browse?at=${segments(`refs/tags/${target.name}`)}`;
        case 'azure':
          return `${url}?version=GT${encodeURIComponent(target.name)}`;
      }
      return undefined;
    case 'compare':
      switch (kind) {
        case 'github':
        case 'gitea':
          return `${url}/compare/${target.from}...${target.to}`;
        case 'gitlab':
          return `${url}/-/compare/${target.from}...${target.to}`;
        case 'azure':
          return `${url}/branchCompare?baseVersion=GC${target.from}&targetVersion=GC${target.to}&_a=files`;
      }
      return undefined;
  }
}

// ---- links in messages ----------------------------------------------------------------------

/** A run of a message: plain text, or text that links somewhere. */
export interface MessagePart {
  readonly text: string;
  readonly url?: string;
}

/** Where a host keeps issue `number` (GitLab merge requests: `!number`). */
function issueUrl(host: CodeHost, number: string, mergeRequest = false): string | undefined {
  switch (host.kind) {
    case 'github':
    case 'gitea':
      return mergeRequest ? undefined : `${host.url}/issues/${number}`;
    case 'gitlab':
      return `${host.url}/-/${mergeRequest ? 'merge_requests' : 'issues'}/${number}`;
    case 'azure': {
      // Azure Repos link #number to the project's work items.
      const at = host.url.indexOf('/_git/');
      return mergeRequest || at < 0 ? undefined : `${host.url.slice(0, at)}/_workitems/edit/${number}`;
    }
  }
  return undefined;
}

/** Text a link may not end with: sentence punctuation, and closing brackets it did not open. */
function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last && '.,;:!?\'"*_'.includes(last)) end--;
    else if (last === ')' || last === ']' || last === '}') {
      const open = last === ')' ? '(' : last === ']' ? '[' : '{';
      const text = url.slice(0, end);
      if (text.split(open).length >= text.split(last).length) break;
      end--;
    } else break;
  }
  return url.slice(0, end);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits a commit message into text and links: web addresses, issue references of the message's
 * host (`#12`, `GH-12`, `owner/repo#12`, GitLab's `!12`) and the configured autolinks
 * (`PROJ-12`). With no host, only addresses and autolinks link.
 */
export function linkMessage(
  text: string,
  host: CodeHost | undefined,
  autolinks: readonly Autolink[] = [],
): MessagePart[] {
  const patterns = [
    '(?<url>\\bhttps?://[^\\s<>"\'`]+)',
    // Another repository on the same host: owner/repo#12 (GitLab: group/subgroup/project!12).
    '(?<![\\w./@-])(?<repo>[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+)(?<repoSign>[#!])(?<repoNumber>\\d+)\\b',
    ...autolinks.map(
      (link, index) =>
        `(?<![\\w-])(?<auto${index}>${escapeRegExp(link.prefix)})(?<auto${index}Id>${link.alphanumeric ? '[A-Za-z0-9]+' : '\\d+'})\\b`,
    ),
    '\\b(?<gh>GH-)(?<ghNumber>\\d+)\\b',
    '(?<![\\w/#&!@-])(?<sign>[#!])(?<number>\\d+)\\b',
  ];
  const pattern = new RegExp(patterns.join('|'), 'g');
  const parts: MessagePart[] = [];
  let plain = 0;
  const push = (start: number, matched: string, url: string | undefined) => {
    if (!url) return;
    if (start > plain) parts.push({ text: text.slice(plain, start) });
    parts.push({ text: matched, url });
    plain = start + matched.length;
  };
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const groups = match.groups ?? {};
    if (groups.url) {
      const url = trimUrl(groups.url);
      push(match.index, url, url);
      // What was trimmed off (a closing bracket, a full stop) is read again as text.
      pattern.lastIndex = match.index + url.length;
      continue;
    }
    if (groups.repo) {
      // owner/repo on GitHub and Gitea, any depth of groups on GitLab.
      if (!host || (host.kind !== 'gitlab' && groups.repo.split('/').length !== 2)) continue;
      const origin = host.url.slice(0, host.url.length - host.repository.length - 1);
      if (!host.url.endsWith(`/${host.repository}`)) continue;
      const other: CodeHost = { ...host, url: `${origin}/${groups.repo}`, repository: groups.repo };
      push(match.index, match[0], issueUrl(other, groups.repoNumber!, groups.repoSign === '!'));
      continue;
    }
    const auto = autolinks.findIndex((_, index) => groups[`auto${index}`] !== undefined);
    if (auto >= 0) {
      const id = groups[`auto${auto}Id`]!;
      push(match.index, match[0], autolinks[auto]!.url.replaceAll('<num>', encodeURIComponent(id)));
      continue;
    }
    if (groups.gh) {
      if (host?.kind === 'github') push(match.index, match[0], issueUrl(host, groups.ghNumber!));
      continue;
    }
    if (groups.sign && host) push(match.index, match[0], issueUrl(host, groups.number!, groups.sign === '!'));
  }
  if (plain < text.length) parts.push({ text: text.slice(plain) });
  return parts;
}
