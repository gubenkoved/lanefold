import type { RefInfo } from '../../../shared/models';
import { errorText } from '../../bridge/errorText';
import type { HostRpc } from '../../bridge/host';
import { openMenu, type MenuEntry } from '../../components/Menu';
import { toast } from '../../components/Toast';
import { shortSha } from '../../graph/format';
import type { GraphView } from '../../graph/GraphView';
import type { LogSource, ReposLogModel } from '../../graph/reposLogModel';
import { fetchCommitDetails } from '../../state/queries';
import { openAllDiffs } from '../log/diffActions';
import { openCommitChanges } from '../log/logMenus';
import { copyWithToast } from '../log/parts';
import { showInRepository } from './reposTab';

export interface ReposMenuContext {
  readonly rpc: HostRpc;
  readonly model: ReposLogModel;
  readonly graph: GraphView;
}

const KIND_LABEL: Record<RefInfo['kind'], string> = { branch: 'Branch', remote: 'Remote branch', tag: 'Tag' };

/** A greyed-out entry saying where the actions people look for are. */
function elsewhere(actions: string, source: LogSource): MenuEntry {
  return {
    id: 'elsewhere',
    label: `${actions}: in ${source.name}’s own log`,
    icon: 'info',
    disabled: true,
    reason: `This view only reads: “Show in ${source.name}” opens its own log`,
    onSelect: () => undefined,
  };
}

/** "Show in <repository>" (switches to it, selects the commit), and what is done there. */
function showInEntries(source: LogSource, sha: string, actions: string): MenuEntry[] {
  return [
    { kind: 'separator' },
    {
      id: 'show-in',
      label: `Show in ${source.name}`,
      icon: 'repo-selected',
      onSelect: () => showInRepository(source.repoId, sha),
    },
    elsewhere(actions, source),
  ];
}

function patchEntries(rpc: HostRpc, repoId: string, commits: readonly string[]): MenuEntry[] {
  const what = commits.length === 1 ? 'patch' : `patch of ${commits.length} commits`;
  return [
    {
      id: 'copy-patch',
      label: commits.length === 1 ? 'Copy as patch' : `Copy ${commits.length} commits as a patch`,
      icon: 'clippy',
      hint: 'git format-patch --stdout',
      onSelect: () =>
        void rpc
          .call('patch.text', { repoId, shas: commits })
          .then((text) => copyWithToast(text, what))
          .catch((error: unknown) =>
            toast('Could not create the patch', { kind: 'error', detail: errorText(error) }),
          ),
    },
    {
      id: 'save-patch',
      label: 'Save as patch file…',
      icon: 'save-as',
      hint: 'git format-patch',
      onSelect: () =>
        void rpc
          .call('patch.save', { repoId, shas: commits })
          .then((file) => file && toast('Patch saved', { kind: 'success', detail: file }))
          .catch((error: unknown) =>
            toast('Could not save the patch', { kind: 'error', detail: errorText(error) }),
          ),
    },
  ];
}

/**
 * The menu of commits in the log of several repositories. Everything here only reads; changing
 * a repository (check out, merge, rebase…) happens in its own log, which "Show in" opens.
 */
export function showReposRowMenu(context: ReposMenuContext, row: number, x: number, y: number): void {
  const { rpc, model, graph } = context;
  const sha = model.sha(row);
  const source = model.sourceAt(row);
  if (!source) return;
  const anchor = { x, y };
  // The selection, newest first, with each commit's repository.
  const selection = graph.selection
    .map((selected) => ({ sha: selected, row: model.rowOf(selected) }))
    .sort((a, b) => a.row - b.row)
    .map((entry) => entry.sha);
  const sources = new Set(selection.map((selected) => model.sourceOf(selected)));

  if (selection.length > 1) {
    const copy: MenuEntry = {
      id: 'copy-sha',
      label: `Copy ${selection.length} commit hashes`,
      icon: 'copy',
      shortcut: 'Ctrl+C',
      onSelect: () => void copyWithToast(selection.join('\n'), 'hashes'),
    };
    if (sources.size > 1) {
      openMenu(anchor, [
        { kind: 'header', label: `${selection.length} commits from ${sources.size} repositories` },
        copy,
        {
          id: 'compare',
          label: 'Commits of different repositories cannot be compared',
          icon: 'info',
          disabled: true,
          reason: 'Separate repositories share no history to compare',
          onSelect: () => undefined,
        },
      ]);
      return;
    }
    const entries: MenuEntry[] = [{ kind: 'title', label: `${selection.length} commits · ${source.name}` }];
    if (selection.length === 2) {
      const [newer, older] = selection as [string, string];
      entries.push({
        id: 'diff',
        label: 'Open changes between them',
        icon: 'diff-multiple',
        hint: `git diff ${shortSha(older)} ${shortSha(newer)}`,
        onSelect: () =>
          void rpc
            .call('diff.files', { repoId: source.repoId, base: older, target: newer })
            .then((files) =>
              files.length === 0
                ? toast('No differences')
                : openAllDiffs(
                    rpc,
                    source.repoId,
                    `${shortSha(older)} ↔ ${shortSha(newer)}`,
                    files,
                    older,
                    newer,
                  ),
            )
            .catch((error: unknown) =>
              toast('Could not compare', { kind: 'error', detail: errorText(error) }),
            ),
      });
    }
    entries.push(
      copy,
      ...patchEntries(rpc, source.repoId, selection),
      ...showInEntries(source, sha, 'Cherry-pick, revert, squash'),
    );
    openMenu(anchor, entries);
    return;
  }

  const parentRow = model.topology.parentCount(row) > 0 ? model.topology.parentRow(row, 0) : -1;
  const children = model.childrenOf(row);
  openMenu(anchor, [
    { kind: 'title', label: source.name },
    {
      id: 'open',
      label: 'Open changes',
      icon: 'diff-multiple',
      shortcut: 'Enter',
      hint: `git show ${shortSha(sha)}`,
      onSelect: () => void openCommitChanges({ rpc, repoId: source.repoId, model, graph }, sha),
    },
    {
      id: 'compare-worktree',
      label: `Compare with ${source.name}’s working tree`,
      icon: 'diff',
      hint: `git diff ${shortSha(sha)}`,
      onSelect: () =>
        void rpc
          .call('diff.files', { repoId: source.repoId, base: sha, target: 'WORKTREE' })
          .then((files) =>
            files.length === 0
              ? toast('The working tree matches this commit')
              : openAllDiffs(rpc, source.repoId, `${shortSha(sha)} ↔ Working Tree`, files, sha, 'WORKTREE'),
          )
          .catch((error: unknown) => toast('Could not compare', { kind: 'error', detail: errorText(error) })),
    },
    {
      kind: 'submenu',
      id: 'go',
      label: 'Go to',
      icon: 'arrow-down',
      disabled: parentRow < 0 && children.length === 0,
      reason: 'Neither its parent nor a child is in this view',
      entries: [
        {
          id: 'parent',
          label: 'Parent',
          icon: 'arrow-down',
          shortcut: '→',
          disabled: parentRow < 0,
          reason:
            model.topology.parentCount(row) === 0
              ? 'The first commit has no parent'
              : 'Its parent is not in this view',
          onSelect: () => graph.selectRow(parentRow),
        },
        {
          id: 'child',
          label: 'Child',
          icon: 'arrow-up',
          shortcut: '←',
          disabled: children.length === 0,
          reason: 'No newer commit in this view',
          onSelect: () => graph.selectRow(children[children.length - 1]!),
        },
      ],
    },
    { kind: 'separator' },
    {
      kind: 'submenu',
      id: 'copy',
      label: 'Copy',
      icon: 'copy',
      entries: [
        {
          id: 'copy-sha',
          label: 'Commit hash',
          shortcut: 'Ctrl+C',
          hint: sha,
          onSelect: () => void copyWithToast(sha, 'hash'),
        },
        {
          id: 'copy-short',
          label: 'Short hash',
          hint: shortSha(sha),
          onSelect: () => void copyWithToast(shortSha(sha), 'short hash'),
        },
        {
          id: 'copy-subject',
          label: 'Subject',
          onSelect: () => void copyWithToast(model.metaOf(sha)?.subject ?? '', 'subject'),
        },
        {
          id: 'copy-message',
          label: 'Full message',
          onSelect: () =>
            void fetchCommitDetails(rpc, source.repoId, sha).then(
              (details) =>
                copyWithToast(
                  details.body ? `${details.subject}\n\n${details.body}` : details.subject,
                  'message',
                ),
              (error: unknown) =>
                toast('Could not read the message', { kind: 'error', detail: errorText(error) }),
            ),
        },
      ],
    },
    ...patchEntries(rpc, source.repoId, [sha]),
    ...showInEntries(source, sha, 'Check out, branch, merge, rebase'),
  ]);
}

/** The menu of a branch or tag pill: where it is, and where it can be changed. */
export function showReposRefMenu(
  context: ReposMenuContext,
  pill: RefInfo,
  event: {
    readonly currentTarget: EventTarget | null;
    readonly clientX: number;
    readonly clientY: number;
    readonly type?: string;
  },
): void {
  const origin = context.model.refOrigin(pill);
  if (!origin) return;
  const { source, ref } = origin;
  // A right click opens the menu where it happened, like any context menu.
  const anchor =
    event.currentTarget instanceof Element && event.type !== 'contextmenu'
      ? event.currentTarget
      : { x: event.clientX, y: event.clientY };
  openMenu(anchor, [
    { kind: 'title', label: `${KIND_LABEL[ref.kind]} ${ref.short} · ${source.name}` },
    {
      id: 'show-in',
      label: `Show in ${source.name}`,
      icon: 'repo-selected',
      onSelect: () => showInRepository(source.repoId, ref.target),
    },
    elsewhere(ref.kind === 'tag' ? 'Push, delete' : 'Check out, merge, push, delete', source),
    { kind: 'separator' },
    { id: 'copy', label: 'Copy name', icon: 'copy', onSelect: () => void copyWithToast(ref.short, 'name') },
  ]);
}
