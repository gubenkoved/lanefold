/*
 * The journal of operations Lanefold ran: what Undo and Redo step through, what a stopped
 * operation needs to be journaled once it finishes, and how both are kept.
 */

import { randomUUID } from 'node:crypto';
import { isObjectId } from '../../shared/oid';
import type {
  JournalEntry,
  OperationKind,
  OperationPlan,
  RefState,
  WorkState,
} from '../../shared/operations';
import { groupRewrite, splitCommits } from '../../shared/rewrite';
import type { StopRecord } from './opState';
import type { PlanRecord } from './planner';
import { diffRefStates, shortRef } from './refState';

export const JOURNAL_LIMIT = 50;

/**
 * An operation git stopped in the middle of (conflicts, an edit stop). It becomes a journal
 * entry once it finishes, so a single Undo reverts all of it.
 */
export interface PendingEntry {
  readonly title: string;
  readonly kind: OperationKind;
  readonly time: number;
  readonly before: RefState;
  /** The stopped operation (see `operationOrigin`): another one in progress is not this one. */
  readonly origin?: string;
  readonly snapshot?: string;
  /** History edits: what is needed to tell which commit each original commit became. */
  readonly rewrite?: {
    readonly base: string | null;
    /** Original commits per resulting commit (head first), oldest group first. */
    readonly groups: readonly (readonly string[])[];
    readonly authors: Readonly<Record<string, { readonly name: string; readonly time: number }>>;
    /** Commits split into parts (each may become several commits). */
    readonly splits?: readonly string[];
  };
  /** Other branches the operation moves along (`--update-refs`): Undo puts them back too. */
  readonly moves?: readonly string[];
  /** The stash holding the changes it set aside: they come back once it is done or aborted. */
  readonly carried?: string;
}

export interface Journal {
  /** Names the refs that keep this journal's snapshots (one journal per workspace). */
  id?: string;
  undo: JournalEntry[];
  redo: JournalEntry[];
  pending?: PendingEntry;
  stop?: StopRecord;
}

export interface JournalStore {
  load(): Journal | undefined;
  save(journal: Journal): void;
}

/** Checks a journal read back from storage: it may come from an older version, or worse. */
export function validJournal(value: unknown): Journal | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { id, undo, redo, pending, stop } = value as Record<string, unknown>;
  const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';
  const optional = (x: unknown, check: (y: unknown) => boolean) => x === undefined || check(x);
  const refState = (x: unknown): boolean => {
    if (!record(x)) return false;
    const { branch, head, refs } = x;
    return (
      optional(branch, (b) => typeof b === 'string' && !b.startsWith('-')) &&
      optional(head, isObjectId) &&
      record(refs) &&
      Object.entries(refs).every(
        ([name, target]) => /^refs\/(?:heads|tags)\/[^-]/.test(name) && isObjectId(target),
      )
    );
  };
  const workState = (x: unknown): boolean =>
    record(x) && isObjectId(x.worktree) && /^[0-9a-f]{64}$/.test(String((x as Partial<WorkState>).index));
  const entry = (x: unknown): x is JournalEntry =>
    record(x) &&
    typeof x.id === 'string' &&
    typeof x.title === 'string' &&
    refState(x.before) &&
    refState(x.after) &&
    optional(x.snapshot, isObjectId) &&
    optional(x.paths, (p) => Array.isArray(p) && p.every((path) => typeof path === 'string')) &&
    optional(x.afterFiles, workState) &&
    optional(
      x.stash,
      (stash) =>
        record(stash) &&
        optional(stash.created, isObjectId) &&
        optional(stash.removed, (removed) => record(removed) && isObjectId(removed.sha)),
    );
  const list = (x: unknown): x is JournalEntry[] => Array.isArray(x) && x.every(entry);
  if (!list(undo) || !list(redo)) return undefined;
  return {
    id: typeof id === 'string' ? id : undefined,
    undo,
    redo,
    pending:
      record(pending) &&
      typeof pending.title === 'string' &&
      refState(pending.before) &&
      optional(pending.snapshot, isObjectId) &&
      optional(pending.carried, isObjectId)
        ? (pending as unknown as PendingEntry)
        : undefined,
    stop: record(stop) && workState(stop.files) ? (stop as unknown as StopRecord) : undefined,
  };
}

/**
 * The journal entry of a stopped operation that finished. Undo restores what it changed: HEAD
 * and the branch it ran on. Refs made or moved meanwhile (by anyone) are not Undo's to touch.
 */
export function entryFrom(pending: PendingEntry, after: RefState): JournalEntry {
  const { title, kind, before: started, snapshot } = pending;
  const refs = { ...after.refs };
  const branch = started.branch ? `refs/heads/${started.branch}` : undefined;
  // The branch it ran on, and the branches it moved along with it.
  for (const ref of [...(branch ? [branch] : []), ...(pending.moves ?? [])]) {
    if (!ref.startsWith('refs/heads/')) continue;
    const value = started.refs[ref];
    if (value) refs[ref] = value;
    else delete refs[ref];
  }
  const before: RefState = { branch: started.branch, head: started.head, refs };
  return { id: randomUUID(), title, kind, time: Date.now(), before, after, snapshot };
}

/** Branches a plan moves besides the one checked out (a history edit's `--update-refs`). */
export function movedAlong(plan: OperationPlan, before: RefState): string[] | undefined {
  const checkedOut = before.branch ? `refs/heads/${before.branch}` : undefined;
  const moves = plan.changes
    .map((change) => change.ref)
    .filter((ref) => ref.startsWith('refs/heads/') && ref !== checkedOut);
  return moves.length > 0 ? moves : undefined;
}

/** The part of a history edit plan needed after it finishes. */
export function rewriteInfo(record: PlanRecord): NonNullable<PendingEntry['rewrite']> {
  const rewrite = record.rewrite!;
  const authors: Record<string, { name: string; time: number }> = {};
  for (const commit of rewrite.range.commits)
    authors[commit.sha] = { name: commit.authorName, time: commit.authorTime };
  return {
    base: rewrite.range.base,
    groups: groupRewrite(rewrite.entries).map((group) => [
      group.head.sha,
      ...group.members.map((m) => m.sha),
    ]),
    authors,
    splits: splitCommits(rewrite.entries),
  };
}

/** The branch names of a pure rename between two states (one ref gone, one ref new, same value). */
export function renamedBranches(from: RefState, to: RefState): { from: string; to: string } | undefined {
  const changes = diffRefStates(from, to);
  const gone = changes.find((c) => c.from && !c.to && c.ref.startsWith('refs/heads/'));
  const added = changes.find((c) => !c.from && c.to && c.ref.startsWith('refs/heads/'));
  if (changes.length !== 2 || !gone || !added || gone.from !== added.to) return undefined;
  return { from: shortRef(gone.ref), to: shortRef(added.ref) };
}
