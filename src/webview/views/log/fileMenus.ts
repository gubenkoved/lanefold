import type { MouseEvent } from 'react';
import type { ChangedFile } from '../../../shared/models';
import { openMenu, type MenuEntry } from '../../components/Menu';
import { shortSha } from '../../graph/format';
import { runOperation } from '../../state/operations';
import { hostRpc } from '../../state/store';
import { openFileHistoryTab } from './logMenus';
import { copyWithToast } from './parts';
import { submoduleName } from './submodules';

/**
 * Where the commits of a file list are when they are not (necessarily) the active repository's:
 * in the log of several repositories. Nothing offered there changes the repository, and file
 * histories open in its own log.
 */
export interface FileMenuScope {
  /** The repository's name (the menu says its files are changed in its own log). */
  readonly repoName: string;
  /** Opens a file's history in the repository's own log. */
  readonly openHistory: (path: string) => void;
}

/** File entries that only read: they are offered for any repository's commits. */
const READ_ONLY_ENTRIES = new Set(['open-at', 'compare-worktree']);

/** The context menu of a file in a list of changes: open it, plus `extra`, history and paths. */
export function fileMenu(
  file: ChangedFile,
  event: MouseEvent,
  open: () => void,
  extra: readonly MenuEntry[] = [],
  scope?: FileMenuScope,
): void {
  if (file.submodule) {
    submoduleFileMenu(file, event, open);
    return;
  }
  openMenu({ x: event.clientX, y: event.clientY }, [
    { id: 'open', label: 'Open changes', icon: 'diff', onSelect: open },
    ...extra,
    { kind: 'separator' },
    {
      id: 'history',
      label: 'History of this file',
      icon: 'history',
      hint: `git log -- ${file.path}`,
      onSelect: () => (scope ? scope.openHistory(file.path) : openFileHistoryTab(file.path)),
    },
    {
      id: 'copy-path',
      label: 'Copy path',
      icon: 'copy',
      onSelect: () => void copyWithToast(file.path, 'path'),
    },
    ...(file.oldPath
      ? [
          {
            id: 'copy-old',
            label: 'Copy previous path',
            icon: 'copy',
            onSelect: () => void copyWithToast(file.oldPath!, 'path'),
          } satisfies MenuEntry,
        ]
      : []),
  ]);
}

/**
 * A submodule among changes: its commits (opened in its own repository), its history here and
 * the commit it records. Contents-based actions (restore, revert a change) do not apply.
 */
function submoduleFileMenu(file: ChangedFile, event: MouseEvent, open: () => void): void {
  const { from, to } = file.submodule!;
  const name = submoduleName(file.path);
  const moved = !!from && !!to && from !== to;
  openMenu({ x: event.clientX, y: event.clientY }, [
    {
      id: 'open',
      label: moved ? `Show the commits in ${name}` : `Open ${name} in Lanefold`,
      icon: 'file-submodule',
      hint: moved ? `${shortSha(from!)} → ${shortSha(to!)}` : undefined,
      onSelect: open,
    },
    { kind: 'separator' },
    {
      id: 'history',
      label: 'History of this submodule',
      icon: 'history',
      hint: `git log -- ${file.path}`,
      onSelect: () => openFileHistoryTab(file.path),
    },
    {
      id: 'copy-path',
      label: 'Copy path',
      icon: 'copy',
      onSelect: () => void copyWithToast(file.path, 'path'),
    },
    ...(to
      ? [
          {
            id: 'copy-commit',
            label: 'Copy the commit hash',
            icon: 'copy',
            hint: shortSha(to),
            onSelect: () => void copyWithToast(to, 'commit hash'),
          } satisfies MenuEntry,
        ]
      : []),
  ]);
}

/** What can be done with one file of a commit (beyond opening its changes). */
export function commitFileEntries(
  repoId: string,
  file: ChangedFile,
  sha: string,
  base: string | undefined,
  scope?: FileMenuScope,
): MenuEntry[] {
  const rpc = hostRpc();
  const deleted = file.status === 'D';
  const paths = file.oldPath ? [file.path, file.oldPath] : [file.path];
  const entries: MenuEntry[] = [
    {
      id: 'open-at',
      label: deleted ? 'Open the deleted version' : 'Open this version',
      icon: 'go-to-file',
      disabled: deleted && !base,
      reason: 'No earlier version of it is known here',
      onSelect: () =>
        void rpc
          .call('file.open', { repoId, path: file.path, rev: deleted ? base : sha })
          .catch(() => undefined),
    },
    {
      id: 'compare-worktree',
      label: 'Compare with the working tree',
      icon: 'diff',
      disabled: deleted,
      reason: 'This commit deletes it',
      onSelect: () =>
        void rpc
          .call('diff.open', {
            repoId,
            title: `${file.path.slice(file.path.lastIndexOf('/') + 1)} (${shortSha(sha)} ↔ Working Tree)`,
            left: { path: file.path, rev: sha },
            right: { path: file.path, rev: 'WORKTREE' },
          })
          .catch(() => undefined),
    },
    { kind: 'separator' },
    {
      id: 'restore',
      label: 'Restore this version',
      icon: 'history',
      hint: `git restore --source=${shortSha(sha)} -- ${file.path}`,
      disabled: deleted,
      reason: 'This commit deletes it: it has no version here to restore',
      onSelect: () => void runOperation({ kind: 'restoreFiles', source: sha, paths: [file.path] }),
    },
    {
      id: 'revert-change',
      label: 'Revert this change',
      icon: 'discard',
      hint: `git diff ${shortSha(sha)}^ ${shortSha(sha)} -- ${file.path} | git apply -R --3way`,
      onSelect: () => void runOperation({ kind: 'applyFileChanges', commit: sha, paths, reverse: true }),
    },
    {
      id: 'apply-change',
      label: 'Apply this change to the working tree',
      icon: 'arrow-down',
      hint: `git diff ${shortSha(sha)}^ ${shortSha(sha)} -- ${file.path} | git apply --3way`,
      onSelect: () => void runOperation({ kind: 'applyFileChanges', commit: sha, paths }),
    },
  ];
  if (!scope) return entries;
  // Files change from the repository's own log: here, say so rather than leave it out.
  return [
    ...entries.filter((entry) => 'id' in entry && READ_ONLY_ENTRIES.has(entry.id)),
    { kind: 'separator' },
    {
      id: 'changes-elsewhere',
      label: `Restore, revert, apply: in ${scope.repoName}’s own log`,
      icon: 'info',
      disabled: true,
      reason: `This view only reads: “Show in ${scope.repoName}” opens its own log`,
      onSelect: () => undefined,
    },
  ];
}
