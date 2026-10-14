import type { RefInfo } from '../../../shared/models';
import { errorText } from '../../bridge/errorText';
import type { HostRpc } from '../../bridge/host';
import { openMenu, type MenuAnchor, type MenuEntry } from '../../components/Menu';
import { openPicker } from '../../components/Picker';
import { toast } from '../../components/Toast';
import { isWorkingTreeSha, shortSha } from '../../graph/format';
import type { DragItem, GraphView } from '../../graph/GraphView';
import type { LogModel } from '../../graph/logModel';
import { changeIndex } from '../../state/indexChanges';
import { runOperation, useOperations } from '../../state/operations';
import { fetchCommitDetails } from '../../state/queries';
import { hostRpc, showStashes, useApp } from '../../state/store';
import { compareTitle, type CompareMode } from '../../state/tabs';
import { customRevision, refPickerItems } from '../refItems';
import {
  commitRewriteEntries,
  dropRewriteEntries,
  editableHistory,
  selectionRewriteEntries,
} from '../rewrite/entryPoints';
import { openAllDiffs } from './diffActions';
import { copyWithToast } from './parts';
import { editBlocker, headContains } from './reach';
import { deleteGoneEntries } from './remoteMenu';
import { goneBranches } from './upstreams';

export interface MenuContext {
  readonly rpc: HostRpc;
  readonly repoId: string;
  readonly model: LogModel;
  readonly graph: GraphView;
}

const nothing = () => undefined;

/** A commit named for people in a menu: its subject, quoted (its short hash until that is loaded). */
function commitName(model: LogModel, sha: string): string {
  const subject = model.metaOf(sha)?.subject;
  return subject ? `“${subject}”` : shortSha(sha);
}

/** The fold entries of a drop, naming the commit folded into by its subject (not its hash). */
function namedFolds(model: LogModel, entries: readonly MenuEntry[], target: string): MenuEntry[] {
  const name = commitName(model, target);
  return entries.map((entry) =>
    'onSelect' in entry && (entry.id === 'squash-into' || entry.id === 'fixup-into')
      ? { ...entry, label: `${entry.id === 'squash-into' ? 'Squash' : 'Fixup'} into ${name}…` }
      : entry,
  );
}

/** Whether a menu offers anything to do (not only disabled items). */
const actionable = (entries: readonly MenuEntry[]) =>
  entries.some(
    (entry) =>
      (entry.kind === undefined || entry.kind === 'item' || entry.kind === 'submenu') && !entry.disabled,
  );

/** Why nothing can be done on top of HEAD yet (an unborn branch), if so. */
function unbornReason(model: LogModel): string | undefined {
  const head = model.refs.head;
  return head.unborn ? `${head.branch ?? 'HEAD'} has no commits yet` : undefined;
}

/**
 * The history editor's entries for a commit; for one it cannot reach, Reword and Edit history
 * stay in the menu, disabled, saying why (the branch to check out, or where editing stops).
 */
function rewriteEntries(model: LogModel, sha: string): MenuEntry[] {
  const entries = commitRewriteEntries(model, sha);
  if (entries.length > 0) return entries;
  const reason = editBlocker(model, sha, editableHistory(model));
  return [
    { kind: 'separator' },
    {
      id: 'reword',
      label: 'Reword…',
      icon: 'edit',
      shortcut: 'F2',
      disabled: true,
      reason,
      onSelect: nothing,
    },
    {
      kind: 'submenu',
      id: 'rewrite',
      label: 'Edit history',
      icon: 'git-pull-request-draft',
      disabled: true,
      reason,
      entries: [],
    },
  ];
}

/** Stages every uncommitted change (conflicts aside), then reviews amending `commit` with them. */
async function stageAllAndAmend({ rpc, repoId }: MenuContext, commit: string): Promise<void> {
  try {
    const changes = await rpc.call('repo.worktreeChanges', { repoId });
    const paths = [...changes.unstaged, ...changes.untracked]
      // A submodule whose folder is gone is checked out again, not staged as removed.
      .filter((file) => !(file.submodule && file.status === 'D'))
      .map((file) => file.path);
    if (paths.length === 0) {
      toast('There are no changes to stage');
      return;
    }
    await changeIndex(repoId, rpc.call('index.stage', { repoId, paths }));
    void runOperation({ kind: 'amendInto', commit }, { review: true });
  } catch (error) {
    toast('Could not stage the changes', { kind: 'error', detail: errorText(error) });
  }
}

export function openCompareTab(a: string, b: string, mode: CompareMode): void {
  const compare = { a, b, mode };
  useApp.getState().addTab({ kind: 'compare', title: compareTitle(compare), compare });
}

export function openHistoryTab(rev: string, title = rev): void {
  useApp.getState().addTab({ kind: 'log', title, view: { scope: { type: 'refs', refs: [rev] } } });
}

/** A folder next to the repository's for a branch's worktree ("../aurora-feature-login"). */
export function siblingFolder(repoRoot: string, branch: string): string {
  const root = repoRoot.replace(/[\\/]+$/, '');
  const parent = root.replace(/[\\/][^\\/]*$/, '');
  const name = root.slice(parent.length + 1);
  return `${parent}/${name}-${branch.replace(/[\\/]+/g, '-')}`;
}

/** A folder typed relative to the repository, made absolute (as git resolves it). */
function absoluteFolder(repoRoot: string, folder: string): string {
  if (/^(?:[a-zA-Z]:)?[\\/]/.test(folder)) return folder;
  const parts = `${repoRoot.replace(/[\\/]+$/, '')}/${folder}`.split(/[\\/]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.') out.push(part);
  }
  return out.join('/');
}

/** Checks a branch out in a new worktree (reviewed in a form), then offers to open it. */
export function openInNewWorktree(repoId: string, branch: string): void {
  void runOperation(
    { kind: 'addWorktree', path: siblingFolder(repoId, branch), branch },
    {
      onDone: (result, operation) => {
        if (result.status !== 'done' || operation.kind !== 'addWorktree') return;
        const folder = absoluteFolder(repoId, operation.path);
        toast(`${operation.branch ?? operation.newBranch} is checked out in ${folder}`, {
          kind: 'success',
          action: {
            label: 'Open in New Window',
            run: () => void hostRpc().call('host.command', { command: 'openFolder', args: { path: folder } }),
          },
          durationMs: 8000,
          group: 'operation',
        });
      },
    },
  );
}

/** The history of a file or folder (on the current branch) in a new tab. */
export function openFileHistoryTab(path: string, rev?: string): void {
  useApp.getState().addTab({
    kind: 'log',
    title: path.slice(path.lastIndexOf('/') + 1) || path,
    view: { scope: rev ? { type: 'refs', refs: [rev] } : { type: 'head' }, paths: [path] },
  });
}

/** "main" when HEAD is on a branch (reads better in titles), else "HEAD". */
function headName(model: LogModel): string {
  return model.refs.head.branch ?? 'HEAD';
}

/** Lets the user pick the other side of a comparison. */
export function pickCompareTarget(anchor: MenuAnchor, model: LogModel, onPick: (rev: string) => void): void {
  openPicker(anchor, {
    title: 'Compare with',
    placeholder: 'Branch, tag or commit hash',
    items: refPickerItems(model.refs, { includeHead: true }),
    custom: customRevision,
    onPick: ([rev]) => rev && onPick(rev),
  });
}

/** Opens the changes of one commit (against its first parent) in the multi-file diff. */
export async function openCommitChanges({ rpc, repoId }: MenuContext, sha: string): Promise<void> {
  try {
    const details = await fetchCommitDetails(rpc, repoId, sha);
    if (details.files.length === 0) {
      toast('This commit changes no files');
      return;
    }
    openAllDiffs(rpc, repoId, `${shortSha(sha)} ${details.subject}`, details.files, details.diffBase, sha);
  } catch (error) {
    toast('Could not load the commit', { kind: 'error', detail: errorText(error) });
  }
}

export async function openWorkingTreeChanges({ rpc, repoId, model }: MenuContext): Promise<void> {
  const changes = await rpc.call('repo.worktreeChanges', { repoId });
  const files = [
    ...new Map(
      [...changes.conflicted, ...changes.staged, ...changes.unstaged].map((f) => [f.path, f]),
    ).values(),
  ];
  if (files.length === 0) {
    toast('No changes to tracked files', {
      detail: changes.untracked.length ? `${changes.untracked.length} untracked` : undefined,
    });
    return;
  }
  openAllDiffs(
    rpc,
    repoId,
    'Uncommitted changes',
    files,
    model.refs.head.unborn ? undefined : 'HEAD',
    'WORKTREE',
  );
}

/**
 * Bisect entries for a commit: while bisecting, mark it; otherwise start a bisect from it (as the
 * bad commit) or from two selected commits (newer bad, older good).
 */
function bisectEntries(sha: string, olderGood?: string): MenuEntry[] {
  const state = useOperations.getState().opState;
  if (state?.kind === 'bisect') {
    return [
      { kind: 'separator' },
      { kind: 'header', label: 'Bisect' },
      ...(['good', 'bad', 'skip'] as const).map((verdict): MenuEntry => ({
        id: `bisect-${verdict}`,
        label: verdict === 'skip' ? 'Skip this commit' : `Mark as ${verdict}`,
        icon: verdict === 'good' ? 'pass' : verdict === 'bad' ? 'error' : 'debug-step-over',
        hint: `git bisect ${verdict} ${shortSha(sha)}`,
        onSelect: () => void runOperation({ kind: 'bisectMark', verdict, commit: sha }),
      })),
    ];
  }
  if (state?.kind) return [];
  return [
    { kind: 'separator' },
    {
      id: 'bisect-start',
      label: olderGood ? 'Find the commit that broke it (bisect)…' : 'Find what broke this commit (bisect)…',
      icon: 'search',
      hint: olderGood
        ? `git bisect start ${shortSha(sha)} ${shortSha(olderGood)}`
        : `git bisect start ${shortSha(sha)} <good>`,
      onSelect: () =>
        void runOperation({ kind: 'bisectStart', bad: sha, good: olderGood ? [olderGood] : [] }),
    },
  ];
}

/** Selected SHAs in graph order (newest first). */
function orderedSelection(context: MenuContext): string[] {
  const { model, graph } = context;
  return graph.selection
    .map((sha) => ({ sha, row: model.rowOf(sha) }))
    .sort((a, b) => a.row - b.row)
    .map((entry) => entry.sha);
}

export function showRowMenu(context: MenuContext, row: number, x: number, y: number): void {
  const { rpc, repoId, model, graph } = context;
  const sha = model.sha(row);
  const selection = orderedSelection(context);
  const anchor = { x, y };
  const patchEntries = (commits: readonly string[]): MenuEntry[] => {
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
  };
  const copyEntries = (shas: readonly string[]): MenuEntry[] => {
    const commits = shas.filter((s) => !isWorkingTreeSha(s));
    if (commits.length === 0) return [];
    if (commits.length > 1) {
      return [
        { kind: 'separator' },
        {
          id: 'copy-sha',
          label: `Copy ${commits.length} commit hashes`,
          icon: 'copy',
          shortcut: 'Ctrl+C',
          onSelect: () => void copyWithToast(commits.join('\n'), 'hashes'),
        },
        ...patchEntries(commits),
      ];
    }
    const sha = commits[0]!;
    return [
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
              void fetchCommitDetails(rpc, repoId, sha).then(
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
      ...patchEntries([sha]),
    ];
  };

  const commitsOnly = selection.filter((s) => !isWorkingTreeSha(s));
  const unborn = unbornReason(model);
  // Commits the checked-out history already has: nothing to pick.
  const allOnBranch = commitsOnly.length > 0 && headContains(model, commitsOnly) === true;
  const several: MenuEntry[] =
    commitsOnly.length > 1
      ? [
          { kind: 'separator' },
          {
            id: 'cherry-pick-all',
            label: `Cherry-pick ${commitsOnly.length} commits onto ${model.refs.head.branch ?? 'HEAD'}`,
            icon: 'git-commit',
            hint: 'git cherry-pick <oldest> … <newest>',
            disabled: !!unborn || allOnBranch,
            reason: unborn ?? `${model.refs.head.branch ?? 'HEAD'} already contains them`,
            onSelect: () => void runOperation({ kind: 'cherryPick', commits: commitsOnly }, { review: true }),
          },
          {
            id: 'revert-all',
            label: `Revert ${commitsOnly.length} commits`,
            icon: 'discard',
            hint: 'git revert <newest> … <oldest>',
            disabled: !!unborn,
            reason: unborn,
            onSelect: () => void runOperation({ kind: 'revert', commits: commitsOnly }, { review: true }),
          },
        ]
      : [];

  if (selection.length === 2) {
    const [newer, older] = selection as [string, string];
    const worktree = isWorkingTreeSha(newer) || isWorkingTreeSha(older);
    const olderRev = isWorkingTreeSha(older) ? newer : older;
    openMenu(anchor, [
      { kind: 'header', label: 'Two commits' },
      {
        id: 'diff',
        label: 'Open changes between them',
        icon: 'diff-multiple',
        hint: worktree ? `git diff ${shortSha(olderRev)}` : `git diff ${shortSha(older)} ${shortSha(newer)}`,
        onSelect: () => {
          const target = worktree ? 'WORKTREE' : newer;
          void rpc
            .call('diff.files', { repoId, base: olderRev, target })
            .then((files) =>
              files.length === 0
                ? toast('No differences')
                : openAllDiffs(
                    rpc,
                    repoId,
                    `${shortSha(olderRev)} ↔ ${worktree ? 'Working Tree' : shortSha(newer)}`,
                    files,
                    olderRev,
                    target,
                  ),
            )
            .catch((error: unknown) =>
              toast('Could not compare', { kind: 'error', detail: errorText(error) }),
            );
        },
      },
      ...(worktree
        ? []
        : ([
            {
              id: 'compare-tab',
              label: 'Compare in a new tab',
              icon: 'split-horizontal',
              hint: `git log ${shortSha(older)}...${shortSha(newer)}`,
              onSelect: () => openCompareTab(older, newer, 'two-dot'),
            },
          ] satisfies MenuEntry[])),
      ...several,
      ...selectionRewriteEntries(model, commitsOnly),
      ...(worktree ? [] : bisectEntries(newer, older)),
      ...copyEntries(selection),
    ]);
    return;
  }

  if (selection.length > 2) {
    openMenu(anchor, [
      { kind: 'header', label: `${selection.length} commits` },
      ...several,
      ...selectionRewriteEntries(model, commitsOnly),
      ...copyEntries(selection),
    ]);
    return;
  }

  if (isWorkingTreeSha(sha)) {
    openMenu(anchor, [
      { kind: 'header', label: 'Uncommitted changes' },
      {
        id: 'open-all',
        label: 'Open all changes',
        icon: 'diff-multiple',
        shortcut: 'Enter',
        hint: 'git diff HEAD',
        onSelect: () => void openWorkingTreeChanges(context),
      },
      { kind: 'separator' },
      {
        id: 'stash',
        label: 'Stash changes…',
        icon: 'git-stash',
        hint: 'git stash push',
        onSelect: () =>
          void runOperation({ kind: 'stashPush', includeUntracked: (model.workingTree?.untracked ?? 0) > 0 }),
      },
      { id: 'stashes', label: 'Show stashes', icon: 'list-unordered', onSelect: showStashes },
    ]);
    return;
  }

  const parents = model.topology.parentCount(row);
  const parentRow = parents > 0 ? model.topology.parentRow(row, 0) : -1;
  const children = model.childrenOf(row);
  const head = model.refs.head;
  const isHead = head.sha === sha;
  const current = head.branch ?? 'HEAD';
  // What HEAD's history has already: picking, merging or rebasing onto it does nothing. The
  // commit checked out is that history itself: those are not offered for it at all.
  const contained = !isHead && headContains(model, sha) === true;
  const already = contained ? `${current} already contains it` : undefined;
  const pick: MenuEntry[] = isHead
    ? []
    : [
        {
          id: 'cherry-pick',
          label: `Cherry-pick onto ${current}`,
          icon: 'git-commit',
          hint: `git cherry-pick ${shortSha(sha)}`,
          disabled: !!(unborn ?? already),
          reason: unborn ?? already,
          onSelect: () => void runOperation({ kind: 'cherryPick', commits: [sha] }),
        },
      ];
  const onto: MenuEntry[] = isHead
    ? []
    : [
        {
          id: 'merge',
          label: `Merge into ${current}`,
          icon: 'git-merge',
          hint: `git merge ${shortSha(sha)}`,
          disabled: !!(unborn ?? already),
          reason: unborn ?? already,
          onSelect: () => void runOperation({ kind: 'merge', source: sha, strategy: 'auto' }),
        },
        {
          id: 'rebase',
          label: `Rebase ${current} onto here`,
          icon: 'git-pull-request',
          hint: `git rebase ${shortSha(sha)}`,
          disabled: !!(unborn ?? already),
          reason: unborn ?? already,
          onSelect: () => void runOperation({ kind: 'rebase', onto: sha }),
        },
      ];
  const operations: MenuEntry[] = [
    { kind: 'separator' },
    {
      id: 'checkout',
      label: 'Check out this commit',
      icon: 'target',
      hint: `git switch --detach ${shortSha(sha)}`,
      disabled: isHead && head.detached,
      reason: 'It is checked out',
      onSelect: () => void runOperation({ kind: 'checkout', target: sha, detach: true }),
    },
    {
      id: 'new-branch',
      label: 'New branch here…',
      icon: 'git-branch-create',
      hint: `git switch -c <name> ${shortSha(sha)}`,
      onSelect: () => void runOperation({ kind: 'createBranch', name: '', at: sha, checkout: true }),
    },
    {
      id: 'new-tag',
      label: 'New tag here…',
      icon: 'tag-add',
      hint: `git tag <name> ${shortSha(sha)}`,
      onSelect: () => void runOperation({ kind: 'createTag', name: '', at: sha }),
    },
    { kind: 'separator' },
    ...pick,
    {
      id: 'revert',
      label: 'Revert this commit',
      icon: 'discard',
      hint: `git revert ${shortSha(sha)}`,
      disabled: !!unborn,
      reason: unborn,
      onSelect: () => void runOperation({ kind: 'revert', commits: [sha] }),
    },
    ...onto,
    {
      id: 'reset',
      label: `Reset ${current} to here…`,
      icon: 'debug-restart',
      hint: `git reset --mixed ${shortSha(sha)}`,
      disabled: !!unborn,
      reason: unborn,
      onSelect: () => void runOperation({ kind: 'reset', to: sha, mode: 'mixed' }),
    },
  ];
  openMenu(anchor, [
    {
      id: 'open',
      label: 'Open changes',
      icon: 'diff-multiple',
      shortcut: 'Enter',
      hint: `git show ${shortSha(sha)}`,
      onSelect: () => void openCommitChanges(context, sha),
    },
    {
      kind: 'submenu',
      id: 'compare',
      label: 'Compare',
      icon: 'git-compare',
      entries: [
        {
          id: 'compare-worktree',
          label: 'With the working tree',
          icon: 'diff',
          hint: `git diff ${shortSha(sha)}`,
          disabled: !!unborn,
          reason: unborn,
          onSelect: () =>
            void rpc
              .call('diff.files', { repoId, base: sha, target: 'WORKTREE' })
              .then((files) =>
                files.length === 0
                  ? toast('The working tree matches this commit')
                  : openAllDiffs(rpc, repoId, `${shortSha(sha)} ↔ Working Tree`, files, sha, 'WORKTREE'),
              )
              .catch((error: unknown) =>
                toast('Could not compare', { kind: 'error', detail: errorText(error) }),
              ),
        },
        // With itself, for the commit checked out: nothing to compare.
        ...(isHead
          ? []
          : ([
              {
                id: 'compare-head',
                label: `With ${headName(model)}`,
                icon: 'git-compare',
                hint: `git diff ${headName(model)}...${shortSha(sha)}`,
                disabled: !!unborn,
                reason: unborn,
                onSelect: () => openCompareTab(headName(model), sha, 'three-dot'),
              },
            ] satisfies MenuEntry[])),
        {
          id: 'compare-with',
          label: 'With…',
          icon: 'git-compare',
          onSelect: () => pickCompareTarget(anchor, model, (rev) => openCompareTab(rev, sha, 'three-dot')),
        },
      ],
    },
    {
      id: 'history',
      label: 'Show history from here',
      icon: 'history',
      hint: `git log ${shortSha(sha)}`,
      onSelect: () => openHistoryTab(sha, shortSha(sha)),
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
          label: parents > 1 ? 'First parent' : 'Parent',
          icon: 'arrow-down',
          shortcut: '→',
          disabled: parentRow < 0,
          reason: parents === 0 ? 'The first commit has no parent' : 'Its parent is not in this view',
          onSelect: () => graph.selectRow(parentRow),
        },
        ...(parents > 1 && model.topology.parentRow(row, 1) >= 0
          ? ([
              {
                id: 'parent-2',
                label: 'Merged parent',
                icon: 'git-merge',
                onSelect: () => graph.selectRow(model.topology.parentRow(row, 1)),
              },
            ] satisfies MenuEntry[])
          : []),
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
    ...operations,
    ...rewriteEntries(model, sha),
    ...bisectEntries(sha),
    ...copyEntries([sha]),
  ]);
}

const KIND_LABEL: Record<RefInfo['kind'], string> = { branch: 'Branch', remote: 'Remote branch', tag: 'Tag' };

/**
 * Moving a branch that is not checked out up to its upstream (`live`, as last fetched), when that
 * only adds commits to it: what a pull would do, without checking it out.
 */
function fastForwardEntries(ref: RefInfo, live: RefInfo | undefined): MenuEntry[] {
  if (ref.isHead || !live || !ref.behind) return [];
  const own = ref.ahead ?? 0;
  return [
    {
      id: 'fast-forward',
      label: `Fast-forward to ${live.short}`,
      icon: 'arrow-down',
      hint: `git branch --force ${ref.short} ${live.short}`,
      disabled: own > 0,
      reason: `${ref.short} has ${own} commit${own === 1 ? '' : 's'} of its own: check it out and pull`,
      onSelect: () => void runOperation({ kind: 'moveBranch', name: ref.short, to: live.short }),
    },
  ];
}

/** Choosing (or changing) the remote branch a branch tracks, and no longer tracking one. */
function upstreamEntries(model: LogModel, ref: RefInfo, anchor: MenuAnchor): MenuEntry[] {
  // Remote branches of the same name first: the usual choice.
  const name = (r: RefInfo) => r.short.slice(r.short.indexOf('/') + 1);
  const candidates = model.refs.refs
    .filter((r) => r.kind === 'remote' && !r.short.endsWith('/HEAD') && r.short !== ref.upstream)
    .sort(
      (a, b) =>
        Number(name(b) === ref.short) - Number(name(a) === ref.short) || a.short.localeCompare(b.short),
    );
  const choose: MenuEntry = {
    id: 'set-upstream',
    label: ref.upstream ? 'Change upstream…' : 'Set upstream…',
    icon: 'cloud',
    hint: `git branch --set-upstream-to=<remote branch> ${ref.short}`,
    disabled: candidates.length === 0,
    reason: ref.upstream
      ? 'There is no other remote branch to track'
      : 'There is no remote branch to track: publishing the branch sets its upstream',
    onSelect: () =>
      openPicker(anchor, {
        title: `Upstream of ${ref.short}`,
        placeholder: 'The remote branch to pull from and push to',
        items: candidates.map((r) => ({
          value: r.short,
          label: r.short,
          icon: 'cloud',
          group: name(r) === ref.short ? 'Same name' : 'Remote branches',
        })),
        onPick: ([upstream]) =>
          upstream && void runOperation({ kind: 'setUpstream', branch: ref.short, upstream }),
      }),
  };
  if (!ref.upstream) return [choose];
  return [
    choose,
    {
      id: 'unset-upstream',
      label: `Stop tracking ${ref.upstream}`,
      icon: 'debug-disconnect',
      hint: `git branch --unset-upstream ${ref.short}`,
      onSelect: () => void runOperation({ kind: 'setUpstream', branch: ref.short }),
    },
  ];
}

/** Merge and rebase entries for a branch's commit: none for the one checked out (itself). */
function intoHeadEntries(model: LogModel, ref: RefInfo): MenuEntry[] {
  if (ref.isHead) return [];
  const into = model.refs.head.branch ?? 'HEAD';
  // Merging or rebasing onto what HEAD already has does nothing.
  const reason =
    unbornReason(model) ??
    (headContains(model, ref.target) ? `${into} already contains ${ref.short}` : undefined);
  return [
    {
      id: 'merge',
      label: `Merge into ${into}`,
      icon: 'git-merge',
      hint: `git merge ${ref.short}`,
      disabled: !!reason,
      reason,
      onSelect: () => void runOperation({ kind: 'merge', source: ref.short, strategy: 'auto' }),
    },
    {
      id: 'rebase',
      label: `Rebase ${into} onto ${ref.short}`,
      icon: 'git-pull-request',
      hint: `git rebase ${ref.short}`,
      disabled: !!reason,
      reason,
      onSelect: () => void runOperation({ kind: 'rebase', onto: ref.short }),
    },
  ];
}

export function showRefMenu(
  context: MenuContext,
  ref: RefInfo,
  event: {
    readonly currentTarget: EventTarget | null;
    readonly clientX: number;
    readonly clientY: number;
    /** A right click opens the menu where it happened, like any context menu. */
    readonly type?: string;
  },
  extra: readonly MenuEntry[] = [],
): void {
  const { model, graph } = context;
  const anchor =
    event.currentTarget instanceof Element && event.type !== 'contextmenu'
      ? event.currentTarget
      : { x: event.clientX, y: event.clientY };
  const current = model.refs.head.branch;
  const upstream = ref.upstream
    ? model.refs.refs.find((r) => r.kind === 'remote' && r.short === ref.upstream)
    : undefined;
  const remotes = [
    ...new Set(model.refs.refs.flatMap((r) => (r.kind === 'remote' && r.remote ? [r.remote] : []))),
  ].sort();
  const refOps: MenuEntry[] = [];
  if (ref.kind === 'branch') {
    // Its upstream as last fetched (not when the remote deleted it): what pull and push go to.
    const live = upstream && !ref.gone ? upstream : undefined;
    const pushedTo = live?.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
    refOps.push(
      // The branch checked out is not checked out, merged or rebased onto again.
      ...(ref.isHead
        ? []
        : ([
            {
              id: 'checkout',
              label: 'Check out',
              icon: 'target',
              hint: `git switch ${ref.short}`,
              onSelect: () => void runOperation({ kind: 'checkout', target: ref.short }),
            },
          ] satisfies MenuEntry[])),
      ...intoHeadEntries(model, ref),
      ...(ref.isHead ? [] : ([{ kind: 'separator' }] satisfies MenuEntry[])),
      ...(ref.isHead && ref.upstream
        ? ([
            {
              id: 'pull',
              label: `Pull from ${ref.upstream}`,
              icon: 'arrow-down',
              hint: `git pull ${ref.upstream.replace('/', ' ')}`,
              onSelect: () =>
                void ((ref.ahead ?? 0) > 0
                  ? runOperation({ kind: 'pull', mode: 'rebase' }, { review: true })
                  : runOperation({ kind: 'pull', mode: 'ff-only' })),
            },
          ] satisfies MenuEntry[])
        : []),
      {
        id: 'push',
        label: ref.upstream ? `Push to ${ref.upstream}` : 'Publish branch',
        icon: ref.upstream ? 'arrow-up' : 'cloud-upload',
        hint: ref.upstream ? `git push ${ref.upstream.replace('/', ' ')}` : `git push -u origin ${ref.short}`,
        // Also to a remote never fetched (the first push), and without one: the plan offers to add it.
        onSelect: () => void runOperation({ kind: 'push', branch: ref.short }),
      },
      // To another remote than its upstream's (a fork, say). One it has stays its upstream.
      ...remotes
        .filter((remote) => remote !== pushedTo)
        .map((remote): MenuEntry => ({
          id: `push-${remote}`,
          label: `Push to ${remote}`,
          icon: 'cloud-upload',
          hint: `git push ${remote} ${ref.short}`,
          onSelect: () => void runOperation({ kind: 'push', branch: ref.short, remote }),
        })),
      ...fastForwardEntries(ref, live),
      { kind: 'separator' },
      {
        id: 'worktree',
        label: 'Open in a new worktree…',
        icon: 'multiple-windows',
        hint: `git worktree add <folder> ${ref.short}`,
        disabled: ref.isHead,
        reason: 'Checked out here (one worktree per branch)',
        onSelect: () => openInNewWorktree(context.repoId, ref.short),
      },
      {
        id: 'rename',
        label: 'Rename…',
        icon: 'edit',
        hint: `git branch -m ${ref.short} <new>`,
        onSelect: () => void runOperation({ kind: 'renameBranch', from: ref.short, to: ref.short }),
      },
      ...upstreamEntries(model, ref, anchor),
      {
        id: 'delete',
        label: 'Delete branch',
        icon: 'trash',
        hint: `git branch -d ${ref.short}`,
        danger: true,
        disabled: ref.isHead,
        reason: 'Check out another branch first',
        onSelect: () => void runOperation({ kind: 'deleteBranch', name: ref.short }),
      },
      // With its branch on the remote, reviewed: that part cannot be undone. (Not for the branch
      // checked out: Delete branch says why.)
      ...(live && !ref.isHead
        ? ([
            {
              id: 'delete-both',
              label: `Delete branch and ${live.short}…`,
              icon: 'trash',
              hint: `git branch -d ${ref.short}, git push ${live.short.replace('/', ' --delete ')}`,
              danger: true,
              onSelect: () =>
                void runOperation({ kind: 'deleteBranch', name: ref.short, remote: true }, { review: true }),
            },
          ] satisfies MenuEntry[])
        : []),
      // Its upstream is gone, and others' too: all of them at once.
      ...(ref.gone && goneBranches(model.refs.refs, []).length > 1
        ? deleteGoneEntries(model.refs.refs, [])
        : []),
    );
  } else if (ref.kind === 'remote') {
    refOps.push(
      {
        id: 'fetch',
        label: `Fetch ${ref.remote ?? 'remote'}`,
        icon: 'repo-fetch',
        hint: `git fetch ${ref.remote ?? ''}`.trim(),
        onSelect: () => void runOperation({ kind: 'fetch', remote: ref.remote }),
      },
      { kind: 'separator' },
      {
        id: 'checkout',
        label: 'Check out as local branch',
        icon: 'target',
        hint: `git switch -c … --track ${ref.short}`,
        onSelect: () => void runOperation({ kind: 'checkout', target: ref.short }),
      },
      ...intoHeadEntries(model, ref),
      { kind: 'separator' },
      {
        id: 'delete-remote',
        label: `Delete from ${ref.remote ?? 'the remote'}…`,
        icon: 'trash',
        hint: `git push ${ref.short.replace('/', ' --delete ')}`,
        danger: true,
        // Always reviewed: Undo cannot bring it back.
        onSelect: () => void runOperation({ kind: 'deleteRemoteBranch', name: ref.short }, { review: true }),
      },
    );
  } else {
    refOps.push(
      {
        id: 'checkout',
        label: 'Check out (detached)',
        icon: 'target',
        hint: `git switch --detach ${ref.short}`,
        onSelect: () => void runOperation({ kind: 'checkout', target: ref.short, detach: true }),
      },
      { kind: 'separator' },
      ...remotes.map((remote): MenuEntry => ({
        id: `push-${remote}`,
        label: `Push to ${remote}`,
        icon: 'cloud-upload',
        hint: `git push ${remote} refs/tags/${ref.short}`,
        onSelect: () => void runOperation({ kind: 'pushTag', name: ref.short, remote }),
      })),
      ...remotes.map((remote): MenuEntry => ({
        id: `delete-remote-${remote}`,
        label: `Delete from ${remote}…`,
        icon: 'cloud',
        hint: `git push ${remote} --delete refs/tags/${ref.short}`,
        danger: true,
        onSelect: () => void runOperation({ kind: 'deleteRemoteTag', name: ref.short, remote }),
      })),
      {
        id: 'delete',
        label: 'Delete tag',
        icon: 'trash',
        hint: `git tag -d ${ref.short}`,
        danger: true,
        onSelect: () => void runOperation({ kind: 'deleteTag', name: ref.short }),
      },
    );
  }
  openMenu(anchor, [
    { kind: 'title', label: `${KIND_LABEL[ref.kind]} ${ref.short}` },
    ...refOps,
    { kind: 'separator' },
    {
      id: 'only',
      label: ref.kind === 'tag' ? 'Show history of this tag' : 'Show only this branch',
      icon: 'filter',
      hint: `git log ${ref.short}`,
      onSelect: () => openHistoryTab(ref.short),
    },
    // With itself, for the branch checked out: nothing to compare.
    ...(ref.isHead
      ? []
      : ([
          {
            id: 'compare-current',
            label: current ? `Compare with ${current}` : 'Compare with HEAD',
            icon: 'git-compare',
            hint: `git diff ${current ?? 'HEAD'}...${ref.short}`,
            disabled: model.refs.head.unborn,
            reason: unbornReason(model),
            onSelect: () => openCompareTab(current ?? 'HEAD', ref.short, 'three-dot'),
          },
        ] satisfies MenuEntry[])),
    {
      id: 'compare-with',
      label: 'Compare with…',
      icon: 'git-compare',
      onSelect: () => pickCompareTarget(anchor, model, (rev) => openCompareTab(rev, ref.short, 'three-dot')),
    },
    ...(upstream
      ? ([
          {
            id: 'upstream',
            label: `Go to ${upstream.short}`,
            icon: 'cloud',
            onSelect: () => {
              if (!graph.goTo(upstream.target)) toast(`${upstream.short} is not in this view`);
            },
          },
        ] satisfies MenuEntry[])
      : []),
    { kind: 'separator' },
    ...extra,
    { id: 'copy', label: 'Copy name', icon: 'copy', onSelect: () => void copyWithToast(ref.short, 'name') },
  ]);
}

/** What a dropped branch or commits can do at the row they were dropped on. */
export function showDropMenu(
  context: MenuContext,
  item: DragItem,
  targetRow: number,
  x: number,
  y: number,
): void {
  const { model } = context;
  const head = model.refs.head;
  const current = head.branch ?? 'HEAD';
  const targetIsWorkingTree = targetRow === 0 && model.hasWorkingTreeRow;
  const targetSha = targetIsWorkingTree ? head.sha : model.sha(targetRow);
  if (!targetSha) return;
  const onHead = targetSha === head.sha;
  // Name the target by its branch when it has exactly one (reads better in commands).
  const branches = (model.refsAt(model.rowOf(targetSha)) ?? []).filter((ref) => ref.kind === 'branch');
  const target = branches.length === 1 ? branches[0]!.short : targetSha;
  const targetLabel = branches.length === 1 ? branches[0]!.short : shortSha(targetSha);
  const anchor = { x, y };

  // A drop that can do nothing there says why in a toast (and offers what would work) rather
  // than opening a menu of greyed-out items.
  if (item.kind === 'changes') {
    const blocked = editBlocker(model, targetSha, editableHistory(model), 'amend');
    if (blocked) {
      toast(blocked);
      return;
    }
    const name = commitName(model, targetSha);
    if ((model.workingTree?.staged ?? 0) === 0) {
      toast(`Nothing is staged to amend ${name} with`, {
        detail: 'Stage what goes into it, or all of it.',
        action: { label: 'Stage all and amend…', run: () => void stageAllAndAmend(context, targetSha) },
        durationMs: 8000,
      });
      return;
    }
    openMenu(anchor, [
      { kind: 'title', label: `Uncommitted changes → ${targetLabel}` },
      {
        id: 'amend-into',
        label: `Amend ${name} with the staged changes…`,
        icon: 'diff-added',
        hint: onHead ? 'git commit --amend --no-edit' : 'git commit --fixup, git rebase --autosquash',
        onSelect: () => void runOperation({ kind: 'amendInto', commit: targetSha }, { review: true }),
      },
    ]);
    return;
  }

  if (item.kind === 'commits') {
    const n = item.shas.length;
    const them = n === 1 ? 'it' : 'them';
    const chain = editableHistory(model);
    const inBranch = item.shas.every((sha) => chain.has(sha));
    const dragged =
      n === 1 ? (model.metaOf(item.shas[0]!)?.subject ?? shortSha(item.shas[0]!)) : `${n} commits`;
    const entries: MenuEntry[] = [{ kind: 'title', label: `${dragged} → ${targetLabel}` }];
    const pick = () => void runOperation({ kind: 'cherryPick', commits: item.shas }, { review: n > 1 });
    // Commits of the current branch are already there: they can be folded together instead.
    const contained = !inBranch && headContains(model, item.shas) === true;
    const missedHead = !inBranch && !contained && !onHead && !head.unborn;
    const blocked =
      unbornReason(model) ??
      (contained
        ? `${current} already contains ${them}`
        : missedHead
          ? `Drop ${them} on ${current} to cherry-pick ${them} there`
          : undefined);
    if (!inBranch) {
      entries.push({
        id: 'cherry-pick',
        label: `Cherry-pick onto ${current}`,
        icon: 'git-commit',
        hint: `git cherry-pick ${n === 1 ? shortSha(item.shas[0]!) : '<oldest> … <newest>'}`,
        disabled: !!blocked,
        reason: blocked,
        onSelect: pick,
      });
    }
    const rewrite =
      n === 1 ? namedFolds(model, dropRewriteEntries(model, item.shas[0]!, targetSha), targetSha) : [];
    entries.push(...(entries.length === 1 ? rewrite.slice(1) : rewrite));
    if (!actionable(entries)) {
      if (inBranch && n > 1)
        toast(`${current} already has these commits`, { detail: 'Their menu squashes them together.' });
      else if (inBranch) toast(`Drop it on another commit of ${current} to fold it in`);
      // Dropped short of HEAD: picking it is still one click away.
      else if (missedHead && blocked)
        toast(blocked, { action: { label: `Cherry-pick onto ${current}`, run: pick }, durationMs: 6000 });
      else toast(blocked ?? 'Nothing to do there');
      return;
    }
    openMenu(anchor, entries);
    return;
  }

  const ref = item.ref;
  if (ref.target === targetSha && ref.kind !== 'remote') {
    toast(`${ref.short} is already there`);
    return;
  }
  const entries: MenuEntry[] = [{ kind: 'title', label: `${ref.short} → ${targetLabel}` }];
  if (ref.kind === 'branch' && ref.isHead) {
    // Onto a commit the branch already has: rebasing or merging does nothing.
    const has = headContains(model, targetSha) ? `${ref.short} already contains ${targetLabel}` : undefined;
    entries.push(
      {
        id: 'rebase',
        label: `Rebase ${ref.short} onto ${targetLabel}`,
        icon: 'git-pull-request',
        hint: `git rebase ${target === targetSha ? shortSha(targetSha) : target}`,
        disabled: !!has,
        reason: has,
        onSelect: () => void runOperation({ kind: 'rebase', onto: target }),
      },
      {
        id: 'merge',
        label: `Merge ${targetLabel} into ${ref.short}`,
        icon: 'git-merge',
        hint: `git merge ${target === targetSha ? shortSha(targetSha) : target}`,
        disabled: !!has,
        reason: has,
        onSelect: () => void runOperation({ kind: 'merge', source: target, strategy: 'auto' }),
      },
      {
        id: 'reset',
        label: `Reset ${ref.short} to ${targetLabel}…`,
        icon: 'debug-restart',
        hint: `git reset --mixed ${shortSha(targetSha)}`,
        onSelect: () => void runOperation({ kind: 'reset', to: targetSha, mode: 'mixed' }),
      },
    );
  } else {
    if (onHead && !head.unborn) {
      const has = headContains(model, ref.target) ? `${current} already contains ${ref.short}` : undefined;
      entries.push(
        {
          id: 'merge',
          label: `Merge ${ref.short} into ${current}`,
          icon: 'git-merge',
          hint: `git merge ${ref.short}`,
          disabled: !!has,
          reason: has,
          onSelect: () => void runOperation({ kind: 'merge', source: ref.short, strategy: 'auto' }),
        },
        {
          id: 'rebase',
          label: `Rebase ${current} onto ${ref.short}`,
          icon: 'git-pull-request',
          hint: `git rebase ${ref.short}`,
          disabled: !!has,
          reason: has,
          onSelect: () => void runOperation({ kind: 'rebase', onto: ref.short }),
        },
      );
    }
    if (ref.kind === 'branch') {
      entries.push({
        id: 'move',
        label: `Move ${ref.short} here`,
        icon: 'arrow-right',
        hint: `git branch --force ${ref.short} ${shortSha(targetSha)}`,
        onSelect: () => void runOperation({ kind: 'moveBranch', name: ref.short, to: targetSha }),
      });
    }
  }
  entries.push(
    { kind: 'separator' },
    {
      id: 'compare',
      label: `Compare ${ref.short} with ${targetLabel}`,
      icon: 'git-compare',
      onSelect: () => openCompareTab(target, ref.short, 'three-dot'),
    },
  );
  openMenu(anchor, entries);
}
