import { GITLINK_MODE } from './diff';

/** A submodule as .gitmodules describes it. */
export interface GitmodulesEntry {
  readonly name: string;
  readonly path?: string;
  readonly url?: string;
  readonly branch?: string;
  /** How `git submodule update` updates it (checkout, rebase, merge, none). */
  readonly update?: string;
}

/**
 * Parses `git config -z --get-regexp '^submodule\.'` (of .gitmodules or the repository's
 * settings): "submodule.<name>.<key>\n<value>" records. Names may contain dots; the key is the
 * last part. Entries come in the order their names first appear.
 */
export function parseSubmoduleConfig(stdout: string): GitmodulesEntry[] {
  const entries = new Map<string, Record<string, string>>();
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const newline = record.indexOf('\n');
    const key = newline < 0 ? record : record.slice(0, newline);
    const value = newline < 0 ? '' : record.slice(newline + 1);
    if (!key.startsWith('submodule.')) continue;
    const rest = key.slice('submodule.'.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) continue;
    const name = rest.slice(0, dot);
    const entry = entries.get(name) ?? {};
    entry[rest.slice(dot + 1).toLowerCase()] = value;
    entries.set(name, entry);
  }
  return [...entries].map(([name, values]) => ({
    name,
    path: values.path,
    url: values.url,
    branch: values.branch,
    update: values.update,
  }));
}

/**
 * Whether a submodule path from .gitmodules is one Lanefold uses: relative, normalized, inside
 * the repository and not in a .git folder (git itself refuses such paths; a hostile .gitmodules
 * may still have them).
 */
export function isSafeSubmodulePath(path: string | undefined): path is string {
  if (!path || path.startsWith('-') || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  return path
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

/** Values of `git config -z --get-regexp` ("<key>\n<value>" records), by key as git prints it. */
export function parseConfigValues(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const newline = record.indexOf('\n');
    values.set(newline < 0 ? record : record.slice(0, newline), newline < 0 ? '' : record.slice(newline + 1));
  }
  return values;
}

/** A URL git reads as a local path (no scheme, no "host:" of scp-like syntax before a slash). */
function localUrl(url: string): boolean {
  const colon = url.indexOf(':');
  const slash = url.indexOf('/');
  return colon < 0 || (slash >= 0 && slash < colon) || /^[a-zA-Z]:\//.test(url);
}

/**
 * A relative submodule URL ("../lib.git") resolved the way `git submodule init` does: against the
 * superproject's remote URL (or, without a remote, its folder, with forward slashes). Other URLs
 * come back as they are; undefined when git could not resolve it either.
 */
export function resolveSubmoduleUrl(url: string, base: string): string | undefined {
  if (!url.startsWith('./') && !url.startsWith('../')) return url;
  let remote = base.endsWith('/') ? base.slice(0, -1) : base;
  const relative = localUrl(remote) && !remote.startsWith('/') && !/^[a-zA-Z]:\//.test(remote);
  if (relative && !remote.startsWith('./') && !remote.startsWith('../')) remote = `./${remote}`;
  let rest = url;
  let colon = false;
  for (;;) {
    if (rest.startsWith('../')) {
      rest = rest.slice(3);
      // Up one level: the last "/" part of the remote, else what follows its "host:".
      const slash = remote.lastIndexOf('/');
      const at = remote.lastIndexOf(':');
      if (slash >= 0) remote = remote.slice(0, slash);
      else if (at >= 0) {
        remote = remote.slice(0, at);
        colon = true;
      } else if (relative || remote === '.') return undefined;
      else remote = '.';
    } else if (rest.startsWith('./')) rest = rest.slice(2);
    else break;
  }
  let resolved = `${remote}${colon ? ':' : '/'}${rest}`;
  if (rest.endsWith('/')) resolved = resolved.slice(0, -1);
  return resolved.startsWith('./') ? resolved.slice(2) : resolved;
}

/** A conflict over a submodule, from the index: the commit each side records for it. */
export interface GitlinkConflict {
  readonly path: string;
  /** The current side's commit (stage 2; undefined: that side removed it). */
  readonly ours?: string;
  /** The incoming side's commit (stage 3; undefined: that side removed it). */
  readonly theirs?: string;
}

/**
 * The submodule conflicts in `git ls-files --unmerged -z` ("<mode> <oid> <stage>\t<path>"):
 * paths whose every stage is a gitlink. A gitlink against a file is no choice of commits.
 */
export function parseGitlinkConflicts(stdout: string): GitlinkConflict[] {
  const stages = new Map<string, { mode: string; oid: string; stage: string }[]>();
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, oid, stage] = record.slice(0, tab).split(' ');
    if (!mode || !oid || !stage) continue;
    const path = record.slice(tab + 1);
    stages.set(path, [...(stages.get(path) ?? []), { mode, oid, stage }]);
  }
  return [...stages]
    .filter(([, entries]) => entries.every((entry) => entry.mode === GITLINK_MODE))
    .map(([path, entries]) => ({
      path,
      ours: entries.find((entry) => entry.stage === '2')?.oid,
      theirs: entries.find((entry) => entry.stage === '3')?.oid,
    }));
}

/** A gitlink in the index: the commit it records, or the sides of a conflict over it. */
export interface GitlinkEntry {
  readonly path: string;
  /** The recorded commit (stage 0); undefined while conflicted. */
  readonly oid?: string;
  /** A merge left several commits for it (stages 1–3). */
  readonly conflicted: boolean;
  /** While conflicted: the current side's commit (stage 2), if it has one. */
  readonly ours?: string;
}

/** Parses `git ls-files --stage -z` ("<mode> <oid> <stage>\t<path>"), keeping the gitlinks only. */
export function parseGitlinks(stdout: string): Map<string, GitlinkEntry> {
  const links = new Map<string, GitlinkEntry>();
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, oid, stage] = record.slice(0, tab).split(' ');
    if (mode !== GITLINK_MODE || !oid) continue;
    const path = record.slice(tab + 1);
    const known = links.get(path);
    if (stage === '0') links.set(path, { path, oid, conflicted: false });
    else links.set(path, { path, conflicted: true, ours: stage === '2' ? oid : known?.ours });
  }
  return links;
}
