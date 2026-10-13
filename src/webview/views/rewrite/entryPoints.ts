/**
 * Ways into the history editor from the graph: context menus on commits and selections, and
 * dropping a commit onto another. Each opens the editor already arranged, so the result and the
 * exact commands are visible before anything runs.
 */
import { foldInto, squashSelection, type RewriteEntry } from '../../../shared/rewrite';
import type { MenuEntry } from '../../components/Menu';
import { shortSha } from '../../graph/format';
import type { LogModel } from '../../graph/logModel';
import { runOperation } from '../../state/operations';
import { startRewrite } from '../../state/rewrite';

/** The most commits offered for editing from the graph (the editor takes up to 1000). */
const CHAIN_LIMIT = 1000;

/**
 * Commits a history edit can reach: the current branch's history from HEAD down to the first
 * merge commit (exclusive) or the root. Map of sha → distance from HEAD.
 */
export function editableHistory(model: LogModel): Map<string, number> {
  const source = model.source ?? model;
  const chain = new Map<string, number>();
  const head = source.refs.head.sha;
  if (!head) return chain;
  let row = source.rowOf(head);
  while (row >= 0 && chain.size < CHAIN_LIMIT) {
    const topology = source.topology;
    if (topology.parentCount(row) > 1) break;
    chain.set(source.sha(row), chain.size);
    if (topology.parentCount(row) === 0) break;
    row = topology.parentRow(row, 0);
  }
  return chain;
}

/** Why the parent of a commit on the editable history cannot take part in an edit. */
function parentOutOfReach(model: LogModel, parent: string | null): string {
  if (parent === null) return 'The first commit has no parent';
  const source = model.source ?? model;
  const row = source.rowOf(parent);
  return row >= 0 && source.topology.parentCount(row) > 1
    ? `Its parent ${shortSha(parent)} is a merge: history edits stop at merges`
    : `Its parent ${shortSha(parent)} is further back than history edits reach here`;
}

/** The commit before `sha` in the chain (its parent), or null for the root commit. */
function parentOf(model: LogModel, sha: string): string | null {
  const source = model.source ?? model;
  const meta = source.metaOf(sha);
  if (meta) return meta.parents[0] ?? null;
  const row = source.rowOf(sha);
  if (row < 0 || source.topology.parentCount(row) === 0) return null;
  const parentRow = source.topology.parentRow(row, 0);
  return parentRow >= 0 ? source.sha(parentRow) : null;
}

/**
 * How an edit starting after `base` can widen: the base `count` commits further back on the
 * editable history (stopping at the very first commit, or right after a merge) and how many
 * commits that adds. Undefined when nothing older can be edited.
 */
export function olderBase(
  model: LogModel,
  base: string | null,
  count: number,
): { readonly base: string | null; readonly added: number } | undefined {
  if (base === null) return undefined;
  const chain = editableHistory(model);
  let next: string | null = base;
  let added = 0;
  while (added < count && next !== null && chain.has(next)) {
    next = parentOf(model, next);
    added++;
  }
  return added > 0 ? { base: next, added } : undefined;
}

const withAction = (sha: string, action: RewriteEntry['action']) => (entries: RewriteEntry[]) =>
  entries.map((entry) => (entry.sha === sha ? { sha, action } : entry));

/** Menu entries for one commit of the current branch (empty when it cannot be edited). */
export function commitRewriteEntries(model: LogModel, sha: string): MenuEntry[] {
  const chain = editableHistory(model);
  if (!chain.has(sha)) return [];
  const parent = parentOf(model, sha);
  const parentEditable = parent !== null && chain.has(parent);
  const grandparent = parentEditable ? parentOf(model, parent) : null;
  const branch = model.refs.head.branch ?? 'HEAD';
  const staged = model.workingTree?.staged ?? 0;
  return [
    { kind: 'separator' },
    // With something staged, the quickest way to put it into this commit.
    ...(staged > 0
      ? ([
          {
            id: 'amend-into',
            label: 'Amend with the staged changes…',
            icon: 'diff-added',
            hint:
              sha === model.refs.head.sha
                ? 'git commit --amend --no-edit'
                : 'git commit --fixup, rebase --autosquash',
            onSelect: () => void runOperation({ kind: 'amendInto', commit: sha }, { review: true }),
          },
        ] satisfies MenuEntry[])
      : []),
    {
      id: 'reword',
      label: 'Reword…',
      icon: 'edit',
      shortcut: 'F2',
      hint: 'new message, same changes',
      onSelect: () =>
        void startRewrite({
          base: parent,
          arrange: withAction(sha, 'reword'),
          select: [sha],
          editMessage: sha,
        }),
    },
    {
      kind: 'submenu',
      id: 'rewrite',
      label: 'Edit history',
      icon: 'git-pull-request-draft',
      entries: [
        {
          id: 'rewrite-here',
          label: `Edit ${branch} from here…`,
          icon: 'list-ordered',
          hint: `git rebase -i ${parent ? shortSha(parent) : '--root'}`,
          onSelect: () => void startRewrite({ base: parent, select: [sha] }),
        },
        {
          id: 'squash-parent',
          label: 'Squash into parent…',
          icon: 'fold-down',
          hint: 'one commit, both messages',
          disabled: !parentEditable,
          reason: parentEditable ? undefined : parentOutOfReach(model, parent),
          onSelect: () =>
            void startRewrite({
              base: grandparent,
              arrange: withAction(sha, 'squash'),
              select: [sha],
              editMessage: parent!,
            }),
        },
        {
          id: 'fixup-parent',
          label: 'Fixup into parent…',
          icon: 'combine',
          hint: 'one commit, parent’s message',
          disabled: !parentEditable,
          reason: parentEditable ? undefined : parentOutOfReach(model, parent),
          onSelect: () =>
            void startRewrite({ base: grandparent, arrange: withAction(sha, 'fixup'), select: [sha] }),
        },
        {
          id: 'edit-stop',
          label: 'Stop here to amend…',
          icon: 'debug-pause',
          hint: 'git rebase -i (edit)',
          onSelect: () =>
            void startRewrite({ base: parent, arrange: withAction(sha, 'edit'), select: [sha] }),
        },
        {
          id: 'split',
          label: 'Split commit…',
          icon: 'split-vertical',
          // Its changes go back to the working tree on top of its parent: the first commit has none.
          hint: 'commit its changes in parts',
          disabled: parent === null,
          reason: 'The first commit has nothing before it to split from',
          onSelect: () =>
            void startRewrite({ base: parent, arrange: withAction(sha, 'split'), select: [sha] }),
        },
        { kind: 'separator' },
        {
          id: 'drop',
          label: 'Drop commit…',
          icon: 'trash',
          danger: true,
          hint: 'leave it out of the history',
          onSelect: () =>
            void startRewrite({ base: parent, arrange: withAction(sha, 'drop'), select: [sha] }),
        },
      ],
    },
  ];
}

/** Menu entries for several selected commits of the current branch. */
export function selectionRewriteEntries(model: LogModel, shas: readonly string[]): MenuEntry[] {
  const chain = editableHistory(model);
  const commits = shas.filter((sha) => chain.has(sha));
  if (commits.length < 2 || commits.length !== shas.length) return [];
  // Oldest = farthest from HEAD.
  const oldest = commits.reduce((a, b) => (chain.get(a)! > chain.get(b)! ? a : b));
  const base = parentOf(model, oldest);
  const selected = new Set(commits);
  const n = commits.length;
  return [
    { kind: 'separator' },
    {
      id: 'squash-selection',
      label: `Squash ${n} commits…`,
      icon: 'fold-down',
      hint: 'into the oldest, messages combined',
      onSelect: () =>
        void startRewrite({
          base,
          arrange: (entries) => squashSelection(entries, selected, 'squash'),
          select: commits,
          editMessage: oldest,
        }),
    },
    {
      id: 'fixup-selection',
      label: `Fixup ${n - 1} into the oldest…`,
      icon: 'combine',
      hint: `keeps ${shortSha(oldest)}’s message`,
      onSelect: () =>
        void startRewrite({
          base,
          arrange: (entries) => squashSelection(entries, selected, 'fixup'),
          select: commits,
        }),
    },
    {
      id: 'rewrite-selection',
      label: 'Edit history from the oldest…',
      icon: 'git-pull-request-draft',
      hint: `git rebase -i ${base ? shortSha(base) : '--root'}`,
      onSelect: () => void startRewrite({ base, select: commits }),
    },
    {
      id: 'drop-selection',
      label: `Drop ${n} commits…`,
      icon: 'trash',
      danger: true,
      onSelect: () =>
        void startRewrite({
          base,
          arrange: (entries) =>
            entries.map((entry) => (selected.has(entry.sha) ? { ...entry, action: 'drop' } : entry)),
          select: commits,
        }),
    },
  ];
}

/** Menu entries for a commit dropped onto another commit of the current branch. */
export function dropRewriteEntries(model: LogModel, dragged: string, target: string): MenuEntry[] {
  const chain = editableHistory(model);
  if (dragged === target || !chain.has(dragged) || !chain.has(target)) return [];
  const older = chain.get(dragged)! > chain.get(target)! ? dragged : target;
  const base = parentOf(model, older);
  const label = shortSha(target);
  return [
    { kind: 'separator' },
    {
      id: 'squash-into',
      label: `Squash into ${label}…`,
      icon: 'fold-down',
      hint: 'one commit, both messages',
      onSelect: () =>
        void startRewrite({
          base,
          arrange: (entries) => foldInto(entries, dragged, target, 'squash'),
          select: [dragged],
          editMessage: target,
        }),
    },
    {
      id: 'fixup-into',
      label: `Fixup into ${label}…`,
      icon: 'combine',
      hint: `keeps ${label}’s message`,
      onSelect: () =>
        void startRewrite({
          base,
          arrange: (entries) => foldInto(entries, dragged, target, 'fixup'),
          select: [dragged],
        }),
    },
  ];
}
