import { execFile } from 'node:child_process';
import {
  codeHostOf,
  isKnownHost,
  parseRemoteUrl,
  preferHosts,
  rewriteUrl,
  type CodeHost,
  type LinkSettings,
  type UrlRewrite,
} from '../../shared/codeHosts';
import { readConfiguredRemotes } from './remotes';
import type { Repository } from './repository';

/** `url.<base>.insteadOf` settings (`git config -z --get-regexp`: `key\nvalue` records ending in NUL). */
export function parseUrlRewrites(config: string): UrlRewrite[] {
  const rewrites: UrlRewrite[] = [];
  for (const record of config.split('\0')) {
    const newline = record.indexOf('\n');
    const match = newline < 0 ? null : /^url\.(.+)\.insteadof$/i.exec(record.slice(0, newline));
    if (match) rewrites.push({ base: match[1]!, prefix: record.slice(newline + 1) });
  }
  return rewrites;
}

async function readUrlRewrites(repo: Repository): Promise<UrlRewrite[]> {
  const { stdout } = await repo.git(['config', '-z', '--get-regexp', '^url\\..+\\.insteadof$'], {
    readOnly: true,
    background: true,
    label: 'URL rewrites',
    // 1: none is set.
    okExitCodes: [0, 1],
  });
  return parseUrlRewrites(stdout);
}

/** Lookups of SSH host aliases, kept a few minutes: the SSH configuration seldom changes. */
const aliases = new Map<string, { readonly at: number; readonly host: Promise<string | undefined> }>();
const ALIAS_TTL_MS = 5 * 60_000;

/** The host name `ssh -G` reads for an alias (`Host github-work` → `HostName github.com`). */
export function parseSshHostName(output: string): string | undefined {
  return /^hostname\s+(\S+)\s*$/im.exec(output)?.[1]?.toLowerCase();
}

/**
 * The host an SSH host name stands for, as the SSH configuration has it (`ssh -G` only prints
 * the configuration, it connects nowhere). Undefined where ssh cannot say.
 */
export function sshHostName(alias: string): Promise<string | undefined> {
  // A plain host name only: nothing ssh could take for an option.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(alias)) return Promise.resolve(undefined);
  const cached = aliases.get(alias);
  if (cached && Date.now() - cached.at < ALIAS_TTL_MS) return cached.host;
  const host = new Promise<string | undefined>((resolve) => {
    execFile('ssh', ['-G', alias], { windowsHide: true, timeout: 5000 }, (error, stdout) =>
      resolve(error ? undefined : parseSshHostName(stdout)),
    );
  });
  aliases.set(alias, { at: Date.now(), host });
  return host;
}

/**
 * The repository's remotes that are on a code host, in the order links prefer them (see
 * `preferHosts`). Their URLs are read as git uses them: rewritten by `insteadOf`, and over SSH
 * with host aliases looked up.
 */
export async function readCodeHosts(
  repo: Repository,
  settings: LinkSettings,
  lookUpAlias: (alias: string) => Promise<string | undefined> = sshHostName,
): Promise<CodeHost[]> {
  const [remotes, rewrites] = await Promise.all([readConfiguredRemotes(repo), readUrlRewrites(repo)]);
  const hosts = await Promise.all(
    remotes.map(async (remote) => {
      const url = remote.urls[0];
      let address = url === undefined ? undefined : parseRemoteUrl(rewriteUrl(url, rewrites));
      if (!address) return undefined;
      if (address.scheme === 'ssh' && !isKnownHost(address.host, settings.hosts)) {
        const real = await lookUpAlias(address.host);
        if (real) address = { ...address, host: real };
        // An alias ssh could not look up names no host.
        else if (!address.host.includes('.')) return undefined;
      }
      return codeHostOf(remote.name, address, settings.hosts);
    }),
  );
  return preferHosts(hosts.filter((host): host is CodeHost => host !== undefined));
}

/** The remotes whose branches have `sha` (of `remotes`: names may hold slashes, the longest wins). */
export async function remotesContaining(
  repo: Repository,
  sha: string,
  remotes: readonly string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  const { stdout } = await repo.git(
    ['for-each-ref', `--contains=${sha}`, '--format=%(refname)', 'refs/remotes/'],
    {
      readOnly: true,
      background: true,
      label: 'Remotes that have a commit',
      signal,
    },
  );
  const byLength = [...remotes].sort((a, b) => b.length - a.length);
  const found = new Set<string>();
  for (const name of stdout.split('\n')) {
    const rest = name.startsWith('refs/remotes/') ? name.slice('refs/remotes/'.length) : undefined;
    const remote =
      rest === undefined ? undefined : byLength.find((candidate) => rest.startsWith(`${candidate}/`));
    if (remote && rest !== `${remote}/HEAD`) found.add(remote);
  }
  return found;
}

/**
 * The newest commit of HEAD's first-parent history that a remote has (HEAD itself once pushed):
 * a link to a file there shows what the working tree has, as far as anyone else can see it.
 * Undefined when nothing of that history is on a remote.
 */
export async function pushedCommit(repo: Repository): Promise<string | undefined> {
  const head = await repo.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
    readOnly: true,
    background: true,
    label: 'Read HEAD',
    okExitCodes: [0, 1],
  });
  const sha = head.stdout.trim();
  if (!sha) return undefined;
  // The commits not on a remote yet, newest first, then (marked "-") the one they start from.
  const { stdout } = await repo.git(['rev-list', '--first-parent', '--boundary', sha, '--not', '--remotes'], {
    readOnly: true,
    background: true,
    label: 'Newest pushed commit',
  });
  if (!stdout.trim()) return sha;
  return /^-([0-9a-f]+)$/m.exec(stdout)?.[1];
}
