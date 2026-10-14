import type { RefInfo, RemoteInfo } from '../../../shared/models';
import { openMenu, type MenuAnchor, type MenuEntry } from '../../components/Menu';
import { runOperation } from '../../state/operations';
import { addRemote } from '../../state/remotes';
import { copyWithToast } from './parts';
import { goneBranches } from './upstreams';

/** The host hid credentials written into this URL (`https://***@…`). */
const hidesCredentials = (url: string | undefined) => !!url && url.includes('://***@');

/**
 * Deleting the branches whose upstream is gone (on `remote` only, when given) all at once, after
 * a review: no entry when there are none. The one checked out stays, as the review says.
 */
export function deleteGoneEntries(
  refs: readonly RefInfo[],
  remotes: readonly string[],
  remote?: string,
): MenuEntry[] {
  const gone = goneBranches(refs, remotes, remote);
  if (gone.length === 0) return [];
  const names = gone.map((ref) => ref.short);
  const deletable = gone.filter((ref) => !ref.isHead);
  return [
    {
      id: 'delete-gone',
      label: 'Delete branches whose upstream is gone…',
      icon: 'trash',
      hint: `git branch -d ${deletable.map((ref) => ref.short).join(' ')}`,
      danger: true,
      disabled: deletable.length === 0,
      reason: `${names[0]} is checked out: switch to another branch first`,
      onSelect: () => void runOperation({ kind: 'deleteBranches', names }, { review: true }),
    },
  ];
}

/** Fetches a remote; with `prune`, its remote branches deleted there go here too. */
export function fetchRemote(name: string, prune = false): void {
  void runOperation({ kind: 'fetch', remote: name, ...(prune ? { prune } : {}) });
}

/** Renames a remote: the new name is typed in the review sheet. */
export function renameRemote(name: string): void {
  void runOperation({ kind: 'renameRemote', from: name, to: name });
}

/** Removes a remote, always after review: its remote branches go with it. */
export function removeRemote(name: string): void {
  void runOperation({ kind: 'removeRemote', name }, { review: true });
}

/**
 * Changes a remote's URL. The form starts from the current one, unless credentials were hidden
 * from it (the webview never has them): then it starts empty.
 */
export function changeRemoteUrl(remote: RemoteInfo): void {
  const url = hidesCredentials(remote.url) ? '' : (remote.url ?? '');
  void runOperation({ kind: 'setRemoteUrl', name: remote.name, url });
}

function copyUrl(url: string, what: string): void {
  void copyWithToast(url, hidesCredentials(url) ? `${what} (without its credentials)` : what);
}

/**
 * What can be done with a remote, for its section in the branches pane. Without `remote`, the
 * section holds remote branches of a remote that is no longer configured. `refs`: the
 * repository's, for its local branches whose upstream on the remote is gone.
 */
export function remoteMenuEntries(
  name: string,
  remote: RemoteInfo | undefined,
  remotes: readonly RemoteInfo[],
  refs: readonly RefInfo[],
  options: { readonly add?: boolean } = {},
): MenuEntry[] {
  const gone = remote === undefined;
  const goneReason = `${name} is no longer a remote: only its branches are left`;
  const entries: MenuEntry[] = [
    { kind: 'title', label: gone ? `${name} (no longer a remote)` : `Remote ${name}` },
    {
      id: 'fetch',
      label: `Fetch ${name}`,
      icon: 'repo-fetch',
      hint: `git fetch ${name}`,
      disabled: gone,
      reason: goneReason,
      onSelect: () => fetchRemote(name),
    },
    {
      id: 'fetch-prune',
      label: 'Fetch and prune',
      icon: 'repo-fetch',
      hint: `git fetch --prune ${name}`,
      disabled: gone,
      reason: goneReason,
      // Its remote branches that were deleted there go here too.
      onSelect: () => fetchRemote(name, true),
    },
    // What is left of the branches deleted there: the local ones that tracked them.
    ...deleteGoneEntries(
      refs,
      remotes.map((candidate) => candidate.name),
      name,
    ),
    {
      id: 'copy-url',
      label: 'Copy URL',
      icon: 'copy',
      hint: remote?.url,
      disabled: !remote?.url,
      reason: gone ? goneReason : 'It has no URL',
      onSelect: () => remote?.url && copyUrl(remote.url, 'URL'),
    },
  ];
  if (remote?.pushUrl) {
    const pushUrl = remote.pushUrl;
    entries.push({
      id: 'copy-push-url',
      label: 'Copy push URL',
      icon: 'copy',
      hint: pushUrl,
      onSelect: () => copyUrl(pushUrl, 'push URL'),
    });
  }
  entries.push(
    { kind: 'separator' },
    {
      id: 'set-url',
      label: 'Change URL…',
      icon: 'link',
      hint: `git remote set-url ${name} <url>`,
      disabled: gone,
      reason: goneReason,
      onSelect: () => remote && changeRemoteUrl(remote),
    },
    {
      id: 'rename',
      label: 'Rename…',
      icon: 'edit',
      hint: `git remote rename ${name} <new name>`,
      disabled: gone,
      reason: goneReason,
      onSelect: () => renameRemote(name),
    },
    {
      id: 'remove',
      label: 'Remove…',
      icon: 'trash',
      hint: `git remote remove ${name}`,
      danger: true,
      disabled: gone,
      reason: goneReason,
      onSelect: () => removeRemote(name),
    },
  );
  if (options.add !== false) entries.push({ kind: 'separator' }, addRemoteEntry(remotes));
  return entries;
}

function addRemoteEntry(remotes: readonly RemoteInfo[]): MenuEntry {
  return {
    id: 'add',
    label: 'Add remote…',
    icon: 'add',
    hint: 'git remote add <name> <url>',
    onSelect: () => addRemote(remotes),
  };
}

/**
 * Every remote (a submenu of its actions), then adding one: for menus away from the branches pane,
 * which steps aside in a narrow view. One level deep, so it fits there too.
 */
export function remotesMenuEntries(remotes: readonly RemoteInfo[], refs: readonly RefInfo[]): MenuEntry[] {
  return [
    ...remotes.map((remote): MenuEntry => ({
      kind: 'submenu',
      id: `remote:${remote.name}`,
      label: remote.name,
      icon: 'cloud',
      entries: remoteMenuEntries(remote.name, remote, remotes, refs, { add: false }),
    })),
    addRemoteEntry(remotes),
  ];
}

export function showRemoteMenu(
  anchor: MenuAnchor,
  name: string,
  remotes: readonly RemoteInfo[],
  refs: readonly RefInfo[],
): void {
  openMenu(
    anchor,
    remoteMenuEntries(
      name,
      remotes.find((remote) => remote.name === name),
      remotes,
      refs,
    ),
  );
}
