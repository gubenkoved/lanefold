import { linkUrl, type CodeHost, type LinkTarget } from '../../../shared/codeHosts';
import type { ChangedFile, RefInfo } from '../../../shared/models';
import { errorText } from '../../bridge/errorText';
import type { HostRpc } from '../../bridge/host';
import type { MenuEntry } from '../../components/Menu';
import { toast } from '../../components/Toast';
import type { LogModel } from '../../graph/logModel';
import { codeHostsNow, openLink } from '../../state/codeHosts';
import { knownContainment } from './ContainedIn';
import { copyWithToast } from './parts';
import { anyContains } from './reach';

/*
 * Links to the repository's code host, for menus and the commit details. A link to a commit (or
 * a file there) goes to a remote that has the commit, never to one where it would not be found:
 * the first host, in the order links prefer, whose remote branches contain it.
 */

/** Where a link goes, or why there is none. */
export type Link = { readonly url: string; readonly host: CodeHost } | { readonly reason: string };

/** What links need of a view (a menu's context is one). */
export interface LinkContext {
  readonly rpc: HostRpc;
  readonly repoId: string;
  readonly model: LogModel;
}

/** A host's own mark where codicons have one. */
export function hostIcon(host: CodeHost): string {
  return host.kind === 'github' ? 'github' : host.kind === 'azure' ? 'azure-devops' : 'link-external';
}

/** The remotes whose branches are among `refs`. */
export function remotesAmong(refs: readonly RefInfo[]): Set<string> {
  return new Set(refs.flatMap((ref) => (ref.kind === 'remote' && ref.remote ? [ref.remote] : [])));
}

/** Why no host shows a commit: none of their remotes has it. */
export function notPushed(hosts: readonly CodeHost[]): string {
  const [only] = hosts;
  return hosts.length === 1 && only
    ? `Not on ${only.name} yet: no branch of ${only.remote} has it.`
    : 'Not pushed yet: no remote branch has it.';
}

/** The link to `target` on the first host whose remote is one of `remotes` (the ones that have it). */
export function linkOn(hosts: readonly CodeHost[], remotes: ReadonlySet<string>, target: LinkTarget): Link {
  const having = hosts.filter((host) => remotes.has(host.remote));
  for (const host of having) {
    const url = linkUrl(host, target);
    if (url) return { url, host };
  }
  return { reason: having[0] ? `${having[0].name} has no page for it.` : notPushed(hosts) };
}

/** The remotes that have every one of `shas`: as known, or as git says. */
async function remotesHaving(context: LinkContext, shas: readonly string[]): Promise<Set<string>> {
  const { rpc, repoId, model } = context;
  const sets = await Promise.all(
    shas.map(async (sha) =>
      remotesAmong(
        knownContainment(repoId, sha, model.refs) ?? (await rpc.call('commit.containedIn', { repoId, sha })),
      ),
    ),
  );
  return sets.reduce((all, set) => new Set([...all].filter((remote) => set.has(remote))));
}

/** The remotes known to have every one of `shas` without asking git; undefined when not known. */
function remotesKnown(
  context: LinkContext,
  hosts: readonly CodeHost[],
  shas: readonly string[],
): Set<string> | undefined {
  const { repoId, model } = context;
  let common: Set<string> | undefined;
  for (const sha of shas) {
    const known = knownContainment(repoId, sha, model.refs);
    let remotes: Set<string>;
    if (known) remotes = remotesAmong(known);
    else {
      // Read off the loaded graph, remote by remote.
      remotes = new Set();
      for (const host of hosts) {
        const tips = model.refs.refs
          .filter((ref) => ref.kind === 'remote' && ref.remote === host.remote)
          .map((ref) => ref.target);
        const has = anyContains(model, tips, sha);
        if (has === undefined) return undefined;
        if (has) remotes.add(host.remote);
      }
    }
    common = common ? new Set([...common].filter((remote) => remotes.has(remote))) : remotes;
  }
  return common;
}

function act(resolve: () => Promise<Link>, use: (url: string) => void): () => void {
  return () =>
    void resolve().then(
      (link) => ('url' in link ? use(link.url) : toast(link.reason)),
      (error: unknown) => toast('Could not make the link', { kind: 'error', detail: errorText(error) }),
    );
}

/** A menu item (not a separator, a header or a submenu). */
type MenuItem = Extract<MenuEntry, { readonly onSelect: () => void }>;

export interface LinkEntries {
  /** "Open on GitHub". */
  readonly open: MenuItem;
  /** Copies the link. */
  readonly copy: MenuItem;
}

/**
 * Menu items that open a page about commits (`target` shows `shas`) on the code host and copy
 * its link. Undefined when the repository is on no code host. Disabled, saying why, when the
 * loaded graph shows that no host has the commits.
 */
export function commitLinkEntries(
  context: LinkContext,
  target: LinkTarget,
  shas: readonly string[],
  labels: { readonly open?: (host: CodeHost) => string; readonly copy: string },
): LinkEntries | undefined {
  const hosts = codeHostsNow(context.repoId);
  // None of the hosts has such a page (Bitbucket compares no commits): nothing to offer.
  if (!hosts?.some((host) => linkUrl(host, target) !== undefined)) return undefined;
  const known = remotesKnown(context, hosts, shas);
  const link = known ? linkOn(hosts, known, target) : undefined;
  // Unknown: named after the preferred host; choosing it asks git which one has the commits.
  const host = link && 'host' in link ? link.host : hosts[0]!;
  const hint = link && 'url' in link ? link.url : linkUrl(host, target);
  const reason = link && 'reason' in link ? link.reason : undefined;
  const resolve = async () => linkOn(hosts, await remotesHaving(context, shas), target);
  return {
    open: {
      id: 'open-on-host',
      label: labels.open ? labels.open(host) : `Open on ${host.name}`,
      icon: hostIcon(host),
      hint,
      disabled: reason !== undefined,
      reason,
      onSelect: act(resolve, (url) => openLink(context.rpc, url)),
    },
    copy: {
      id: 'copy-link',
      label: labels.copy,
      icon: 'link',
      hint,
      disabled: reason !== undefined,
      reason,
      onSelect: act(resolve, (url) => void copyWithToast(url, 'link')),
    },
  };
}

/**
 * Menu items for a branch's page (where its upstream is), a remote branch's or a tag's (on a
 * host that has its commit). Undefined when the repository is on no code host.
 */
export function refLinkEntries(context: LinkContext, ref: RefInfo): LinkEntries | undefined {
  if (ref.kind === 'tag')
    return commitLinkEntries(context, { kind: 'tag', name: ref.short }, [ref.target], { copy: 'Copy link' });
  const hosts = codeHostsNow(context.repoId);
  if (!hosts?.length) return undefined;
  const remoteRef =
    ref.kind === 'remote'
      ? ref
      : context.model.refs.refs.find((other) => other.kind === 'remote' && other.short === ref.upstream);
  const remote = remoteRef?.remote;
  const host = remote === undefined ? undefined : hosts.find((candidate) => candidate.remote === remote);
  const url =
    host && remoteRef && remote !== undefined
      ? linkUrl(host, { kind: 'branch', name: remoteRef.short.slice(remote.length + 1) })
      : undefined;
  const reason = url
    ? undefined
    : ref.kind === 'branch' && !ref.upstream
      ? `${ref.short} has no upstream branch: push it first.`
      : ref.kind === 'branch' && (ref.gone || !remoteRef)
        ? `${ref.upstream} is gone.`
        : `${remote ?? ref.short} is not on a code host Lanefold knows.`;
  const shown = host ?? hosts[0]!;
  return {
    open: {
      id: 'open-on-host',
      label: `Open on ${shown.name}`,
      icon: hostIcon(shown),
      hint: url,
      disabled: !url,
      reason,
      onSelect: () => url && openLink(context.rpc, url),
    },
    copy: {
      id: 'copy-link',
      label: 'Copy link',
      icon: 'link',
      hint: url,
      disabled: !url,
      reason,
      onSelect: () => url && void copyWithToast(url, 'link'),
    },
  };
}

/** A file's page as a commit left it (a deleted file's: as it was before), or undefined. */
export function fileLinkEntries(
  context: LinkContext,
  file: ChangedFile,
  sha: string,
  base: string | undefined,
): LinkEntries | undefined {
  if (file.submodule) return undefined;
  const rev = file.status === 'D' ? base : sha;
  return rev
    ? commitLinkEntries(context, { kind: 'file', sha: rev, path: file.path }, [rev], { copy: 'Copy link' })
    : undefined;
}
