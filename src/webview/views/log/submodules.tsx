import type { ChangedFile, SubmoduleChange, SubmoduleInfo, SubmoduleState } from '../../../shared/models';
import { errorText } from '../../bridge/errorText';
import { openMenu, type MenuAnchor, type MenuEntry } from '../../components/Menu';
import { toast } from '../../components/Toast';
import { shortSha } from '../../graph/format';
import { runOperation } from '../../state/operations';
import { hostRpc, tabsLoaded, useApp } from '../../state/store';
import { compareTitle } from '../../state/tabs';
import { FileAction } from './FileList';
import { copyWithToast } from './parts';

/** The last part of a submodule's path ("lib" for libs/lib). */
export function submoduleName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

/** The folder a clone of `url` gets by default ("library" for …/library.git). */
export function folderFromUrl(url: string): string {
  return (
    url
      .trim()
      .replace(/[\\/]+$/, '')
      .replace(/\.git$/, '')
      .split(/[\\/:]/)
      .pop() ?? ''
  );
}

/** Short words for a submodule's state (the badge in the branches pane). */
export const SUBMODULE_BADGES: Record<SubmoduleState, string> = {
  uninitialized: 'not initialized',
  missing: 'not checked out',
  upToDate: 'up to date',
  otherCommit: 'other commit',
  dirty: 'changed',
  conflicted: 'conflict',
};

const short = (sha: string | undefined) => (sha ? shortSha(sha) : '∅');

/** Where a submodule stands, in a sentence. */
export function describeSubmodule(submodule: SubmoduleInfo): string {
  const inside = [submodule.modified ? 'edited files' : '', submodule.untracked ? 'new files' : '']
    .filter(Boolean)
    .join(' and ');
  const notes = [
    submodule.nested ? 'it has submodules of its own' : '',
    submodule.settingsUrl ? `.gitmodules changed its URL (fetches still use ${submodule.settingsUrl})` : '',
  ]
    .filter(Boolean)
    .map((note) => `; ${note}`)
    .join('');
  switch (submodule.state) {
    case 'uninitialized':
      return 'Not initialized: not cloned or checked out here';
    case 'missing':
      return `Not checked out: its folder is gone or empty (update checks out ${short(submodule.recorded)} again)${notes}`;
    case 'conflicted':
      return 'Conflicted: a merge left two commits for it';
    case 'otherCommit':
      return `At ${short(submodule.checkedOut)}, not the recorded ${short(submodule.recorded)}${inside ? `; ${inside} inside` : ''}${notes}`;
    case 'dirty':
      return `At the recorded ${short(submodule.recorded)}, with ${inside} inside${notes}`;
    case 'upToDate':
      return `At the recorded ${short(submodule.recorded)}${notes}`;
  }
}

/**
 * Shows a submodule (or worktree) of a repository in Lanefold: the host switches to its
 * repository. Resolves with that repository's id once its tabs are loaded (undefined when it
 * could not be opened, which is reported).
 */
export async function openLinkedRepository(repoId: string, path: string): Promise<string | undefined> {
  try {
    const opened = await hostRpc().call('repo.openLinked', { repoId, path });
    // The switch reached the store before this answer: the new repository's tabs are loading.
    await tabsLoaded();
    return useApp.getState().activeRepoId === opened.repoId ? opened.repoId : undefined;
  } catch (error) {
    toast(`Could not open ${path}`, { kind: 'error', detail: errorText(error) });
    return undefined;
  }
}

/** Reviews `git submodule update` for some submodules (cloning them first, with `init`). */
export function updateSubmodules(paths?: readonly string[], init?: boolean): void {
  void runOperation({ kind: 'updateSubmodules', paths, init: init || undefined }, { review: true });
}

/** Opens the form that adds a submodule. */
export function addSubmodule(): void {
  void runOperation({ kind: 'addSubmodule', url: '', path: '' });
}

/**
 * The submodule a change names: by its path, else by where it was before a move (its previous
 * path, or its name, which a move keeps).
 */
function findSubmodule(
  list: readonly SubmoduleInfo[],
  path: string,
  oldPath?: string,
): SubmoduleInfo | undefined {
  const paths = oldPath ? [path, oldPath] : [path];
  return (
    paths.map((candidate) => list.find((item) => item.path === candidate)).find(Boolean) ??
    paths.map((candidate) => list.find((item) => item.name === candidate)).find(Boolean)
  );
}

/**
 * Shows what a submodule change means: the commits between the two it records, compared in the
 * submodule's own repository (Lanefold switches to it). With one side only, that commit's
 * history; with uncommitted changes inside and no new commit, the repository itself.
 */
export async function showSubmoduleCommits(
  repoId: string,
  path: string,
  change: SubmoduleChange,
  oldPath?: string,
): Promise<void> {
  const list = await hostRpc()
    .call('submodule.list', { repoId })
    .catch(() => undefined);
  const submodule = list && findSubmodule(list, path, oldPath);
  if (!submodule) {
    toast(`${path} is not a submodule here now`, {
      detail: 'Its commits are in its own repository, which this one does not have checked out.',
    });
    return;
  }
  if (submodule.state === 'uninitialized' || submodule.state === 'missing') {
    const uninitialized = submodule.state === 'uninitialized';
    toast(`${submodule.path} is not ${uninitialized ? 'initialized' : 'checked out'}`, {
      detail: `Its commits are here once it is ${uninitialized ? 'cloned' : 'checked out again'}.`,
      action: {
        label: uninitialized ? 'Initialize…' : 'Check it out…',
        run: () => updateSubmodules([submodule.path], uninitialized),
      },
      durationMs: 8000,
    });
    return;
  }
  const opened = await openLinkedRepository(repoId, submodule.path);
  const { from, to } = change;
  if (!opened || from === to) return;
  // Commits it has not fetched cannot be shown.
  const wanted = [to, from].filter((sha): sha is string => !!sha);
  const metas = await hostRpc()
    .call('log.meta', { repoId: opened, shas: wanted })
    .catch(() => []);
  const present = new Set(metas.map((meta) => meta.sha));
  const missing = wanted.filter((sha) => !present.has(sha));
  if (missing.length > 0)
    toast(
      `${submoduleName(submodule.path)} does not have ${missing.map((sha) => shortSha(sha)).join(' or ')}`,
      {
        detail: 'Fetch in it to get the commits it is missing.',
        durationMs: 8000,
      },
    );
  const { addTab } = useApp.getState();
  if (from && to && missing.length === 0) {
    const compare = { a: from, b: to, mode: 'two-dot' as const };
    addTab({ kind: 'compare', title: compareTitle(compare), compare });
    return;
  }
  const only = wanted.find((sha) => present.has(sha));
  if (only) addTab({ kind: 'log', title: shortSha(only), view: { scope: { type: 'refs', refs: [only] } } });
}

/** What can be done with one submodule (its row menu, and its entry in the repository menu). */
export function submoduleMenuEntries(repoId: string, submodule: SubmoduleInfo): MenuEntry[] {
  const { path, state } = submodule;
  const uninitialized = state === 'uninitialized';
  const checkedOut = !uninitialized && state !== 'missing';
  const entries: MenuEntry[] = [
    {
      id: 'open',
      label: 'Open in Lanefold',
      icon: 'repo',
      hint: 'Switch to its repository',
      disabled: !checkedOut,
      reason: uninitialized
        ? 'It is not initialized yet: there is no repository to open'
        : 'Its folder is gone',
      onSelect: () => void openLinkedRepository(repoId, path),
    },
    uninitialized
      ? {
          id: 'init',
          label: 'Initialize and update…',
          icon: 'cloud-download',
          hint: `git submodule update --init -- ${path}`,
          onSelect: () => updateSubmodules([path], true),
        }
      : {
          id: 'update',
          label: state === 'missing' ? 'Check it out again…' : 'Update to the recorded commit…',
          icon: 'sync',
          hint: `git submodule update -- ${path}`,
          disabled: state !== 'otherCommit' && state !== 'missing',
          reason: 'It is at the recorded commit already',
          onSelect: () => updateSubmodules([path]),
        },
  ];
  if (state === 'otherCommit' && submodule.recorded && submodule.checkedOut)
    entries.push({
      id: 'changes',
      label: 'Show changes since the recorded commit',
      icon: 'git-compare',
      hint: `${shortSha(submodule.recorded)} → ${shortSha(submodule.checkedOut)}`,
      onSelect: () =>
        void showSubmoduleCommits(repoId, path, { from: submodule.recorded, to: submodule.checkedOut }),
    });
  entries.push(
    { kind: 'separator' },
    { id: 'copy', label: 'Copy path', icon: 'copy', onSelect: () => void copyWithToast(path, 'path') },
  );
  if (submodule.url)
    entries.push({
      id: 'copy-url',
      label: 'Copy URL',
      icon: 'copy',
      onSelect: () => void copyWithToast(submodule.url!, 'URL'),
    });
  entries.push(
    { kind: 'separator' },
    {
      id: 'sync',
      label: submodule.settingsUrl
        ? 'Sync its changed URL from .gitmodules…'
        : 'Sync its URL from .gitmodules…',
      icon: 'link',
      hint: `git submodule sync -- ${path}`,
      disabled: uninitialized,
      reason: 'It is not initialized yet',
      onSelect: () => void runOperation({ kind: 'syncSubmodules', paths: [path] }, { review: true }),
    },
    {
      id: 'deinit',
      label: 'Deinitialize…',
      icon: 'trash',
      hint: `git submodule deinit -- ${path}`,
      disabled: uninitialized,
      reason: 'It is not initialized',
      onSelect: () => void runOperation({ kind: 'deinitSubmodules', paths: [path] }, { review: true }),
    },
  );
  return entries;
}

/** The context menu of a submodule in the branches pane. */
export function showSubmoduleMenu(repoId: string, submodule: SubmoduleInfo, anchor: MenuAnchor): void {
  openMenu(anchor, [{ kind: 'title', label: submodule.path }, ...submoduleMenuEntries(repoId, submodule)]);
}

/** What can be done with all the submodules at once, or a new one. */
export function allSubmodulesEntries(list: readonly SubmoduleInfo[]): MenuEntry[] {
  const uninitialized = list.some((submodule) => submodule.state === 'uninitialized');
  const behind = list.some((submodule) => submodule.state === 'otherCommit' || submodule.state === 'missing');
  return [
    {
      id: 'update-all',
      label: uninitialized ? 'Initialize and update all…' : 'Update all…',
      icon: 'sync',
      hint: uninitialized ? 'git submodule update --init' : 'git submodule update',
      disabled: !uninitialized && !behind,
      reason: 'Every submodule is at its recorded commit',
      onSelect: () => updateSubmodules(undefined, uninitialized),
    },
    {
      id: 'sync-all',
      label: 'Sync URLs from .gitmodules…',
      icon: 'link',
      hint: 'git submodule sync',
      disabled: list.every((submodule) => submodule.state === 'uninitialized'),
      reason: 'No submodule is initialized yet',
      onSelect: () => void runOperation({ kind: 'syncSubmodules' }, { review: true }),
    },
    { kind: 'separator' },
    { id: 'add', label: 'Add a submodule…', icon: 'add', hint: 'git submodule add', onSelect: addSubmodule },
  ];
}

/** The menu of the Submodules section. */
export function showSubmodulesMenu(list: readonly SubmoduleInfo[], anchor: MenuAnchor): void {
  openMenu(anchor, [{ kind: 'header', label: 'Submodules' }, ...allSubmodulesEntries(list)]);
}

/**
 * The submodules as a menu of their own, each opening its menu in turn (in place, not cascading:
 * the repository menu's way to them where the branches pane does not fit, a narrow side bar).
 */
export function showSubmodulesList(repoId: string, list: readonly SubmoduleInfo[], anchor: MenuAnchor): void {
  openMenu(anchor, [
    { kind: 'header', label: 'Submodules' },
    ...list.map((submodule): MenuEntry => ({
      id: `submodule:${submodule.path}`,
      label: `${submodule.path} · ${SUBMODULE_BADGES[submodule.state]}`,
      icon: 'file-submodule',
      onSelect: () => showSubmoduleMenu(repoId, submodule, anchor),
    })),
    { kind: 'separator' },
    ...allSubmodulesEntries(list),
  ]);
}

/**
 * Row actions of a submodule among uncommitted changes. At another commit: stage that commit like
 * a file, or update the submodule back to the recorded one. Its folder gone: check it out again
 * (staging that would remove the submodule, while .gitmodules still lists it). Changes inside
 * only: they are committed in the submodule, so the action opens it.
 */
export function SubmoduleFileActions({
  repoId,
  file,
  onStage,
}: {
  repoId: string;
  file: ChangedFile;
  onStage: () => void;
}) {
  const { from, to } = file.submodule ?? {};
  if (from && from === to)
    return (
      <FileAction
        icon="repo"
        label={`Open ${submoduleName(file.path)} in Lanefold`}
        onClick={() => void openLinkedRepository(repoId, file.path)}
      />
    );
  if (!to)
    return (
      <FileAction
        icon="sync"
        label="Check it out again…"
        name={`Check ${file.path} out again…`}
        onClick={() => updateSubmodules([file.path])}
      />
    );
  return (
    <>
      <FileAction
        icon="discard"
        label="Update to the recorded commit…"
        name={`Update ${file.path} to the recorded commit…`}
        danger
        onClick={() => updateSubmodules([file.path])}
      />
      <FileAction icon="add" label="Stage" name={`Stage ${file.path}`} onClick={onStage} />
    </>
  );
}
