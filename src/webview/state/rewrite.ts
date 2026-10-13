import { create } from 'zustand';
import type { OperationPlan } from '../../shared/operations';
import {
  cleanMessage,
  firstChange,
  foldManyInto,
  groupMessage,
  groupRewrite,
  normalizeRewrite,
  pickAll,
  rewriteProblem,
  type RewriteAction,
  type RewriteCommit,
  type RewriteEntry,
  type RewriteProblem,
  type RewriteRange,
  type RewriteSimulation,
} from '../../shared/rewrite';
import { errorText } from '../bridge/errorText';
import { toast } from '../components/Toast';
import { noteRenames } from '../graph/renames';
import { refreshOpState, report, useOperations } from './operations';
import { hostRpc, useApp } from './store';

/** One step of the editor's own undo history. */
interface Arrangement {
  readonly entries: readonly RewriteEntry[];
  readonly updateRefs: boolean;
}

/** A history edit being arranged (the "edit mode" of a log tab). */
export interface RewriteSession {
  readonly id: number;
  readonly repoId: string;
  /** The log tab showing the editor. */
  readonly tabId: string;
  readonly range: RewriteRange;
  /** The arrangement, oldest first (the order git applies them). */
  readonly entries: readonly RewriteEntry[];
  readonly updateRefs: boolean;
  /** Selected commits. */
  readonly selection: readonly string[];
  /** The row with keyboard focus. */
  readonly focus?: string;
  /** The group head whose message editor is open. */
  readonly editing?: string;
  readonly past: readonly Arrangement[];
  readonly future: readonly Arrangement[];
  readonly plan?: OperationPlan;
  readonly planning: boolean;
  readonly simulation?: RewriteSimulation;
  readonly simulating: boolean;
  /**
   * Apply was asked for: while `planning` too, it waits for the plan of the arrangement as it was
   * then (which can no longer change), and runs as soon as that plan arrives.
   */
  readonly applying: boolean;
  /** How often Apply was refused (the reason, already shown, lights up again each time). */
  readonly refusals: number;
  readonly error?: string;
}

/** What a session's derived views depend on: the commits and their arrangement. */
export type Arranged = Pick<RewriteSession, 'entries' | 'range'>;

interface RewriteStore {
  readonly session?: RewriteSession;
}

export const useRewrite = create<RewriteStore>(() => ({}));

let sessionCounter = 0;

function current(): RewriteSession | undefined {
  return useRewrite.getState().session;
}

function patch(update: Partial<RewriteSession>, id = current()?.id): void {
  const session = current();
  if (!session || session.id !== id) return;
  useRewrite.setState({ session: { ...session, ...update } });
}

/** Original message of a commit in the session. */
export function messageOf(session: Pick<RewriteSession, 'range'>): (sha: string) => string | undefined {
  const messages = new Map(session.range.commits.map((commit) => [commit.sha, commit.message]));
  return (sha) => messages.get(sha);
}

/** True when the arrangement changes something. */
export function isDirty(session: Arranged): boolean {
  const original = session.range.commits.map((commit) => commit.sha);
  const entries = normalizeRewrite(session.entries, messageOf(session));
  return firstChange(entries, original) < entries.length;
}

/**
 * Why the arrangement cannot be applied: a problem with the arrangement itself (known at once,
 * with the commit it is about), else what its plan says once it is planned.
 */
export function applyProblem(
  session: Arranged & Pick<RewriteSession, 'planning' | 'plan'>,
): (Pick<RewriteProblem, 'message' | 'sha'> & { readonly kind?: RewriteProblem['kind'] }) | undefined {
  const problem = rewriteProblem(session.entries, { fromRoot: session.range.base === null });
  if (problem) return problem;
  if (session.planning || !session.plan?.blocked) return undefined;
  const reason = session.plan.notices.find((notice) => notice.level === 'danger')?.text;
  return reason ? { message: reason } : undefined;
}

/** True while the history editor shows: in the active tab of the active repository. */
export function editorShowing(): boolean {
  const session = current();
  const app = useApp.getState();
  return !!session && session.repoId === app.activeRepoId && session.tabId === app.tabs.activeTabId;
}

/** {@link editorShowing} for components. */
export function useEditorShowing(): boolean {
  const at = useRewrite((state) =>
    state.session ? `${state.session.repoId}\0${state.session.tabId}` : undefined,
  );
  const here = useApp((state) => `${state.activeRepoId ?? ''}\0${state.tabs.activeTabId}`);
  return at === here;
}

// ---- starting and stopping ------------------------------------------------------------------

export interface StartOptions {
  /** The commit the edit starts after (`null`: from the root commit). */
  readonly base: string | null;
  /** Arranges the initial plan (everything picked, oldest first) for a quick action. */
  readonly arrange?: (entries: RewriteEntry[], range: RewriteRange) => RewriteEntry[];
  /** Commits to select (and focus the first of). */
  readonly select?: readonly string[];
  /** Opens the message editor of the group this commit heads. */
  readonly editMessage?: string;
}

/** Opens the history editor in the active log tab. */
export async function startRewrite(options: StartOptions): Promise<void> {
  const app = useApp.getState();
  const repoId = app.activeRepoId;
  const tabId = app.tabs.activeTabId;
  if (!repoId) return;
  const opState = useOperations.getState().opState;
  if (opState?.kind) {
    toast(`A ${opState.kind} is in progress`, { kind: 'error', detail: 'Continue or abort it first.' });
    return;
  }
  let range: RewriteRange | undefined;
  try {
    range = await hostRpc().call('rewrite.range', { repoId, base: options.base });
  } catch (error) {
    toast('Could not read the history', { kind: 'error', detail: errorText(error) });
    return;
  }
  if (!range || (range.commits.length === 0 && !range.tooMany)) {
    toast('There are no commits to edit there');
    return;
  }
  if (range.tooMany) {
    toast(`That is ${range.tooMany.toLocaleString()} commits`, {
      kind: 'error',
      detail: 'Start from a more recent commit.',
    });
    return;
  }
  if (range.merges > 0) {
    toast('This part of the history has merge commits', {
      kind: 'error',
      detail: 'Editing it here would flatten the merges. Start after the most recent merge.',
    });
    return;
  }
  const originals = new Map(range.commits.map((commit) => [commit.sha, commit.message]));
  const entries = (options.arrange?.(pickAll(range.commits), range) ?? pickAll(range.commits)).map((entry) =>
    // A reword starts from the original message, ready to change.
    entry.action === 'reword' && entry.message === undefined
      ? { ...entry, message: cleanMessage(originals.get(entry.sha) ?? '') }
      : entry,
  );
  const select = options.select?.length ? options.select : [range.commits.at(-1)!.sha];
  const session: RewriteSession = {
    id: ++sessionCounter,
    repoId,
    tabId,
    range,
    entries,
    updateRefs: false,
    selection: select,
    focus: select[0],
    editing: options.editMessage,
    past: [],
    future: [],
    planning: true,
    simulating: true,
    applying: false,
    refusals: 0,
  };
  useRewrite.setState({ session });
  schedule(session);
}

export function cancelRewrite(): void {
  clearTimeout(planTimer);
  clearTimeout(simulationTimer);
  simulationController?.abort();
  useRewrite.setState({ session: undefined });
}

// ---- editing --------------------------------------------------------------------------------

/** Replaces the arrangement (recorded for the editor's undo unless `record` is false). */
export function arrange(
  update: (entries: readonly RewriteEntry[], session: RewriteSession) => readonly RewriteEntry[],
  options: { record?: boolean; updateRefs?: boolean } = {},
): void {
  const session = current();
  if (!session || session.applying) return;
  const entries = update(session.entries, session);
  const updateRefs = options.updateRefs ?? session.updateRefs;
  if (entries === session.entries && updateRefs === session.updateRefs) return;
  const record = options.record ?? true;
  // A new message changes no file: the dry run stands (and the header does not flicker while
  // a message is typed).
  const reshaped = !sameShape(entries, session.entries);
  const next: RewriteSession = {
    ...session,
    entries,
    updateRefs,
    past: record
      ? [...session.past, { entries: session.entries, updateRefs: session.updateRefs }].slice(-200)
      : session.past,
    future: record ? [] : session.future,
    planning: true,
    simulating: reshaped || session.simulating,
  };
  useRewrite.setState({ session: next });
  schedule(next, reshaped);
}

/** The same commits, in the same order, with the same actions (messages aside). */
function sameShape(a: readonly RewriteEntry[], b: readonly RewriteEntry[]): boolean {
  return (
    a.length === b.length && a.every((entry, i) => entry.sha === b[i]!.sha && entry.action === b[i]!.action)
  );
}

export function undoArrangement(): void {
  const session = current();
  const previous = session?.past.at(-1);
  if (!session || !previous || session.applying) return;
  const next: RewriteSession = {
    ...session,
    ...previous,
    past: session.past.slice(0, -1),
    future: [{ entries: session.entries, updateRefs: session.updateRefs }, ...session.future],
    planning: true,
    simulating: true,
  };
  useRewrite.setState({ session: next });
  schedule(next);
}

export function redoArrangement(): void {
  const session = current();
  const following = session?.future[0];
  if (!session || !following || session.applying) return;
  const next: RewriteSession = {
    ...session,
    ...following,
    past: [...session.past, { entries: session.entries, updateRefs: session.updateRefs }],
    future: session.future.slice(1),
    planning: true,
    simulating: true,
  };
  useRewrite.setState({ session: next });
  schedule(next);
}

/** Back to the original history (everything picked, in order). */
export function resetArrangement(): void {
  arrange((_, session) => pickAll(session.range.commits), { updateRefs: false });
}

/** Sets the action of commits; rewording opens the message editor prefilled. */
export function setAction(shas: readonly string[], action: RewriteAction): void {
  const targets = new Set(shas);
  if (targets.size === 0) return;
  let editing: string | undefined;
  arrange((entries, session) => {
    const messages = messageOf(session);
    return entries.map((entry) => {
      if (!targets.has(entry.sha) || entry.action === action) return entry;
      if (action === 'reword') {
        editing ??= entry.sha;
        return { sha: entry.sha, action, message: entry.message ?? cleanMessage(messages(entry.sha) ?? '') };
      }
      return entry.message !== undefined && (action === 'pick' || action === 'edit' || action === 'split')
        ? { sha: entry.sha, action, message: entry.message }
        : { sha: entry.sha, action };
    });
  });
  if (editing) patch({ editing });
}

/** Moves the selected commits one row up (newer) or down (older) in the list. */
export function moveSelection(direction: 'up' | 'down'): void {
  arrange((entries, session) => {
    const selected = new Set(session.selection);
    const list = [...entries];
    // Entries are oldest first: "up" in the list (newer) is a higher index.
    if (direction === 'up') {
      if (selected.has(list[list.length - 1]!.sha)) return entries;
      for (let i = list.length - 2; i >= 0; i--) {
        if (selected.has(list[i]!.sha) && !selected.has(list[i + 1]!.sha))
          [list[i], list[i + 1]] = [list[i + 1]!, list[i]!];
      }
    } else {
      if (selected.has(list[0]!.sha)) return entries;
      for (let i = 1; i < list.length; i++) {
        if (selected.has(list[i]!.sha) && !selected.has(list[i - 1]!.sha))
          [list[i], list[i - 1]] = [list[i - 1]!, list[i]!];
      }
    }
    return list;
  });
}

/** Applies a new order given newest first (the list's order), e.g. from dragging. */
export function reorder(shasNewestFirst: readonly string[]): void {
  arrange((entries) => {
    const bySha = new Map(entries.map((entry) => [entry.sha, entry]));
    const next = [...shasNewestFirst].reverse().map((sha) => bySha.get(sha)!);
    return next.every((entry, i) => entry === entries[i]) ? entries : next;
  });
}

/**
 * Folds commits into `target`, as when they are dropped onto it. A squash opens the combined
 * message of the commit that comes out.
 */
export function foldCommits(shas: readonly string[], target: string, action: 'squash' | 'fixup'): void {
  let head: string | undefined;
  arrange((entries) => {
    const moving = new Set(shas);
    const oldestFirst = entries.filter((entry) => moving.has(entry.sha)).map((entry) => entry.sha);
    const next = foldManyInto(entries, oldestFirst, target, action);
    head = groupRewrite(next).find(
      (group) => group.head.sha === target || group.members.some((member) => member.sha === target),
    )?.head.sha;
    return next;
  });
  patch({ selection: [target], focus: target, ...(action === 'squash' && head ? { editing: head } : {}) });
}

/**
 * Widens the edit to older commits: `base` is the new starting point, further back on the same
 * line of history. The added commits are picked, so nothing about them changes unless arranged;
 * the arrangement so far (and its undo history) is kept.
 */
export async function includeOlder(base: string | null): Promise<void> {
  const session = current();
  if (!session || session.applying) return;
  let range: RewriteRange | undefined;
  try {
    range = await hostRpc().call('rewrite.range', { repoId: session.repoId, base });
  } catch (error) {
    toast('Could not read the older commits', { kind: 'error', detail: errorText(error) });
    return;
  }
  const latest = current();
  if (!latest || latest.id !== session.id || latest.applying) return;
  const known = latest.range.commits.map((commit) => commit.sha);
  const wider = range?.commits.map((commit) => commit.sha) ?? [];
  const added = wider.length - known.length;
  // The commits being edited must be the newest of the wider range, as they were.
  if (
    !range ||
    range.tooMany ||
    range.merges > 0 ||
    added <= 0 ||
    known.some((sha, i) => wider[added + i] !== sha)
  ) {
    toast('The history changed', { kind: 'error', detail: 'Start the edit again to include older commits.' });
    return;
  }
  const older = pickAll(range.commits.slice(0, added));
  const widen = (entries: readonly RewriteEntry[]) => [...older, ...entries];
  const next: RewriteSession = {
    ...latest,
    range,
    entries: widen(latest.entries),
    past: latest.past.map((step) => ({ ...step, entries: widen(step.entries) })),
    future: latest.future.map((step) => ({ ...step, entries: widen(step.entries) })),
    planning: true,
    simulating: true,
  };
  useRewrite.setState({ session: next });
  schedule(next);
}

/** Sets the message of the commit a group produces (its head). */
export function setGroupMessage(head: string, message: string): void {
  arrange(
    (entries) =>
      entries.map((entry) => {
        if (entry.sha !== head) return entry;
        const squashes = groupRewrite(entries).find((group) => group.head.sha === head)?.newMessage;
        // A plain pick needs to become a reword for its message to change.
        const action = entry.action === 'pick' && !squashes ? 'reword' : entry.action;
        return { ...entry, action, message };
      }),
    { record: false },
  );
}

/** Drops an explicit message: the group goes back to its default (original or combined). */
export function resetGroupMessage(head: string): void {
  arrange((entries) =>
    entries.map((entry) => {
      if (entry.sha !== head) return entry;
      const { message: _message, ...rest } = entry;
      return rest.action === 'reword' ? { ...rest, action: 'pick' } : rest;
    }),
  );
}

export function setUpdateRefs(updateRefs: boolean): void {
  arrange((entries) => entries, { updateRefs });
}

export function select(sha: string, mode: 'single' | 'toggle' | 'range' = 'single'): void {
  const session = current();
  if (!session) return;
  if (mode === 'single') {
    patch({ selection: [sha], focus: sha });
    return;
  }
  if (mode === 'toggle') {
    const selection = session.selection.includes(sha)
      ? session.selection.filter((s) => s !== sha)
      : [...session.selection, sha];
    patch({ selection, focus: sha });
    return;
  }
  // Range in list order, from the focused row.
  const order = [...session.entries].reverse().map((entry) => entry.sha);
  const from = order.indexOf(session.focus ?? sha);
  const to = order.indexOf(sha);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  patch({ selection: order.slice(lo, hi + 1) });
}

/** Moves keyboard focus up/down the list (extending the selection with Shift). */
export function moveFocus(delta: number, extend: boolean): void {
  const session = current();
  if (!session) return;
  const order = [...session.entries].reverse().map((entry) => entry.sha);
  const index = Math.min(order.length - 1, Math.max(0, order.indexOf(session.focus ?? order[0]!) + delta));
  const sha = order[index]!;
  if (!extend) {
    patch({ selection: [sha], focus: sha });
    return;
  }
  const selection = session.selection.includes(sha)
    ? session.selection.filter((s) => s !== session.focus)
    : [...session.selection, sha];
  patch({ selection: selection.length ? selection : [sha], focus: sha });
}

export function editMessage(head: string | undefined): void {
  // A split's parts get their messages as they are committed; what is left keeps the original.
  if (head && current()?.entries.find((entry) => entry.sha === head)?.action === 'split') return;
  patch({ editing: head });
}

// ---- planning and the dry run ---------------------------------------------------------------

let planTimer: ReturnType<typeof setTimeout> | undefined;
let planToken = 0;
let simulationTimer: ReturnType<typeof setTimeout> | undefined;
let simulationController: AbortController | undefined;

/** Plans the arrangement, and dry-runs it again unless `dryRun` is false (only messages changed). */
function schedule(session: RewriteSession, dryRun = true): void {
  clearTimeout(planTimer);
  // A plan on its way is for an arrangement that is gone: its answer must not count.
  planToken++;
  planTimer = setTimeout(() => void plan(session.id), 140);
  if (!dryRun) return;
  clearTimeout(simulationTimer);
  simulationController?.abort();
  simulationTimer = setTimeout(() => void simulate(session.id), 260);
}

async function plan(id: number): Promise<void> {
  const session = current();
  if (!session || session.id !== id) return;
  const token = ++planToken;
  try {
    const planned = await hostRpc().call('op.plan', {
      repoId: session.repoId,
      operation: {
        kind: 'rewrite',
        base: session.range.base,
        entries: session.entries,
        updateRefs: session.updateRefs,
      },
    });
    if (token !== planToken) return;
    patch({ plan: planned, planning: false, error: undefined }, id);
    // Apply was asked for while this plan was on its way.
    if (current()?.id === id && current()?.applying) await execute(id);
  } catch (error) {
    if (token !== planToken) return;
    const queued = current()?.id === id && current()?.applying;
    patch({ planning: false, applying: false, error: errorText(error) }, id);
    if (queued) toast('Could not apply the edit', { kind: 'error', detail: errorText(error) });
  }
}

async function simulate(id: number): Promise<void> {
  const session = current();
  if (!session || session.id !== id) return;
  const controller = new AbortController();
  simulationController = controller;
  try {
    const simulation = await hostRpc().call(
      'rewrite.simulate',
      { repoId: session.repoId, base: session.range.base, entries: session.entries },
      { signal: controller.signal },
    );
    if (!controller.signal.aborted) patch({ simulation, simulating: false }, id);
  } catch {
    if (!controller.signal.aborted) patch({ simulation: undefined, simulating: false }, id);
  }
}

// ---- applying -------------------------------------------------------------------------------

/**
 * Applies the arrangement. Asked for while it is still being planned (right after a keystroke in
 * the message, say), it is held as it is and applied as soon as its plan arrives; when it cannot
 * be applied, a message says why. Either way the request is never dropped silently.
 */
export async function applyRewrite(): Promise<void> {
  const session = current();
  if (!session || session.applying) return;
  // What is wrong with the arrangement itself is known without its plan.
  if (rewriteProblem(session.entries, { fromRoot: session.range.base === null })) {
    refuse(session);
    return;
  }
  if (session.planning) {
    patch({ applying: true });
    return;
  }
  await execute(session.id);
}

/** Says why the arrangement is not applied. */
function refuse(session: RewriteSession): void {
  if (!isDirty(session)) {
    toast('Nothing to apply yet', { detail: 'Move commits or choose an action first.' });
    return;
  }
  // The reason is in the header and under the list, with the ways out (a toast would cover
  // them): it lights up there again.
  if (applyProblem(session)) {
    patch({ refusals: session.refusals + 1 }, session.id);
    return;
  }
  toast('Can’t apply this edit', { kind: 'error', detail: session.error ?? 'The plan could not be made.' });
}

/** Gives up a queued Apply (to discard the arrangement instead); nothing once git is running it. */
export function holdApply(): void {
  const session = current();
  if (session?.applying && session.planning) patch({ applying: false });
}

async function execute(id: number): Promise<void> {
  const session = current();
  if (!session || session.id !== id) return;
  const planned = session.plan;
  if (!planned || planned.blocked) {
    patch({ applying: false });
    refuse(session);
    return;
  }
  patch({ applying: true });
  try {
    const result = await hostRpc().call('op.execute', { repoId: session.repoId, planId: planned.id });
    if (result.status === 'refused' && result.errorKind === 'stale') {
      toast('The repository changed — the plan was updated', { kind: 'info' });
      patch({ applying: false, planning: true });
      void plan(session.id);
      return;
    }
    if (result.status === 'refused') {
      patch({ applying: false });
      report(result);
      return;
    }
    if (result.rewritten) noteRenames(session.repoId, result.rewritten);
    cancelRewrite();
    report(result);
    void refreshOpState(session.repoId);
  } catch (error) {
    patch({ applying: false, error: errorText(error) });
  }
}

// ---- derived views --------------------------------------------------------------------------

export type RowRole = 'head' | 'member' | 'drop';

/** A row of the plan list (newest first) with what the graph column draws. */
export interface PlanRow {
  readonly entry: RewriteEntry;
  readonly commit: RewriteCommit;
  readonly role: RowRole;
  /** Index of the resulting commit (oldest first), for kept rows. */
  readonly group?: number;
  /** The squash bracket: a member's node, a line passing by, or the curve into the head. */
  readonly bracket?: 'start' | 'member' | 'through' | 'join';
  /** The head this member folds into. */
  readonly into?: string;
}

export function planRows(session: Arranged): PlanRow[] {
  const groups = groupRewrite(session.entries);
  const groupOf = new Map<string, number>();
  const headOf = new Map<string, string>();
  groups.forEach((group, index) => {
    groupOf.set(group.head.sha, index);
    for (const member of group.members) {
      groupOf.set(member.sha, index);
      headOf.set(member.sha, group.head.sha);
    }
  });
  const commits = new Map(session.range.commits.map((commit) => [commit.sha, commit]));
  const newestFirst = [...session.entries].reverse();
  // Rows between a group's newest member and its head carry the bracket line.
  const rows: PlanRow[] = [];
  let open: number | undefined;
  for (const entry of newestFirst) {
    const group = groupOf.get(entry.sha);
    const role: RowRole = entry.action === 'drop' ? 'drop' : headOf.has(entry.sha) ? 'member' : 'head';
    let bracket: PlanRow['bracket'];
    if (role === 'member') {
      bracket = open === group ? 'member' : 'start';
      open = group;
    } else if (role === 'head' && open === group && open !== undefined) {
      bracket = 'join';
      open = undefined;
    } else if (open !== undefined) bracket = 'through';
    rows.push({
      entry,
      commit: commits.get(entry.sha)!,
      role,
      group,
      bracket,
      into: headOf.get(entry.sha),
    });
  }
  return rows;
}

/** A commit the edit produces (newest first in the result list). */
export interface ResultCommit {
  readonly index: number;
  readonly head: RewriteEntry;
  readonly commits: readonly RewriteCommit[];
  readonly message: string;
  /** What the message editor shows: the typed message (even while empty), else `message`. */
  readonly draft: string;
  readonly newMessage: boolean;
  /** The message was typed (not original or combined), even when it is empty for now. */
  readonly customMessage: boolean;
  readonly edit: boolean;
  /** Git stops there with its changes uncommitted, to commit them in parts. */
  readonly split: boolean;
}

export function resultCommits(session: Arranged): ResultCommit[] {
  const messages = messageOf(session);
  const commits = new Map(session.range.commits.map((commit) => [commit.sha, commit]));
  return groupRewrite(session.entries)
    .map((group, index) => ({
      index,
      head: group.head,
      commits: [group.head, ...group.members].map((entry) => commits.get(entry.sha)!),
      message: groupMessage(group, messages),
      draft: group.head.message ?? groupMessage(group, messages),
      newMessage: group.newMessage,
      customMessage: group.newMessage && group.head.message !== undefined,
      edit: group.head.action === 'edit',
      split: group.head.action === 'split',
    }))
    .reverse();
}
