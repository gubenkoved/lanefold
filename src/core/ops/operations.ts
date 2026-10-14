import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isObjectId } from '../../shared/oid';
import type {
  JournalEntry,
  Operation,
  OperationKind,
  OperationPlan,
  OperationResult,
  OpState,
  RefState,
  StashChange,
  UndoInfo,
  WorkState,
} from '../../shared/operations';
import type { RewriteEntry, RewriteRange, RewriteSimulation } from '../../shared/rewrite';
import { filePaths } from '../git/args';
import { GitError } from '../git/errors';
import { resolveCommit } from '../git/queries';
import {
  mapRewritten,
  readRewriteRange,
  runPlannedRebase,
  SimulationCache,
  simulateRewrite,
  type RebaseScript,
} from '../rebase/rewrite';
import { editStopCommit, runSplitStep } from '../rebase/split';
import { removeBranchSettings, restoreBranchSettings } from '../repo/branchSettings';
import type { RepoData } from '../repo/repoData';
import type { Repository } from '../repo/repository';
import { readStashList, stashAt, stashTop } from '../repo/stash';
import { readSubmoduleConflicts, withSubmoduleConflicts } from '../repo/submodules';
import { readWorktrees } from '../repo/worktrees';
import { Emitter } from '../util/emitter';
import { plural } from '../util/wording';
import {
  JOURNAL_LIMIT,
  type JournalStore,
  type PendingEntry,
  entryFrom,
  movedAlong,
  renamedBranches,
  rewriteInfo,
} from './journal';
import { putBackHalfDone, staleFiles, writtenVersions, type HalfDone } from './halfDone';
import { conflictedPaths, operationOrigin, readOpState, workSinceStop, type StopRecord } from './opState';
import { HISTORY_EDIT_MARKER } from './opState';
import { planOperation, type PlanRecord } from './planner';
import { isControl } from './planner';
import { isRemoteOperation, remoteResult } from './plans/remotes';
import { submoduleFailure, submoduleMessage } from './plans/submodules';
import { moveRefs, restageAfterAutostash, stagedEntries } from './refMoves';
import { diffRefStates, headMoved, readRefState, shortRef } from './refState';
import {
  CARRIED_BACK,
  CARRIED_WAIT,
  SAVED_WORK,
  describeChanges,
  describeDone,
  describeError,
  describeGitFailure,
  describeStaleFiles,
  firstSentence,
  NOTHING_CHANGED,
  PUT_BACK,
  quote,
  stashMessage,
  stepResult,
} from './results';
import {
  fingerprintPaths,
  readWorkState,
  releaseSnapshots,
  restoreExact,
  restorePaths,
  restoreSnapshot,
  sameWorkState,
  saveSnapshotAsStash,
  snapshotExists,
  takeSnapshot,
} from './snapshot';
import {
  deletedAlready,
  fetchedDespiteFailure,
  isSyncOperation,
  readSyncRefs,
  syncMessage,
} from './syncResults';
import { pastTense } from './verbs';

const PLAN_TTL_MS = 15 * 60_000;

const LOCK_WAIT_MS = 2000;

export interface RepoOperationsOptions {
  readonly store?: JournalStore;
  /** How to run Lanefold's rebase sequence editor; history editing is off without it. */
  readonly rebaseScript?: RebaseScript;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Text starting with a capital letter. */
const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** Two parts of a message as sentences (`second` may be missing): “a was at 1a2b. b is gone.” */
function sentences(first: string, second: string | undefined): string {
  if (!second) return first;
  if (!first) return second;
  return `${first}${/[.!?]$/.test(first) ? '' : '.'} ${second}`;
}

/** They change the remote or remote-tracking refs, which Undo cannot (and should not) restore. */
const NOT_JOURNALED = new Set<OperationKind>([
  'fetch',
  'push',
  'pushTag',
  'deleteRemoteTag',
  'deleteRemoteBranch',
  // Bisect walks HEAD over commits to test; stopping it returns to where it started.
  'bisectStart',
  'bisectMark',
  // Worktrees are folders: Undo cannot sensibly delete or recreate them.
  'addWorktree',
  'removeWorktree',
  'pruneWorktrees',
  // Submodules are repositories of their own (clones, checkouts, their settings).
  'updateSubmodules',
  'addSubmodule',
  'syncSubmodules',
  'deinitSubmodules',
  // Git settings, not history.
  'setIdentity',
  'setUpstream',
  // Remotes: settings and remote branches (each plan says how to go back).
  'addRemote',
  'renameRemote',
  'removeRemote',
  'setRemoteUrl',
]);

export const short = (sha: string | undefined) => (sha ? sha.slice(0, 8) : '∅');

/** A failure in plain words: git's own, when git failed. */
function failureText(failure: unknown): string {
  if (failure instanceof GitError) return describeGitFailure(failure);
  return failure instanceof Error ? failure.message : String(failure);
}

function sameState(a: RefState, b: RefState): boolean {
  return !headMoved(a, b) && a.head === b.head && diffRefStates(a, b).length === 0;
}

/**
 * Runs operations on one repository, one at a time, under the safety model:
 * plans are checked against the current state before running (refs must be exactly as planned,
 * no other operation in progress, no stale index lock), destructive operations snapshot the
 * working tree first, and every change is journaled so Undo can restore the exact refs.
 */
export class RepoOperations {
  private readonly plans = new Map<string, PlanRecord & { created: number }>();
  private undoStack: JournalEntry[];
  private redoStack: JournalEntry[];
  private pending: PendingEntry | undefined;
  /** What git left at the last stop of an operation Lanefold ran. */
  private stop: StopRecord | undefined;
  private readonly journalId: string;
  /** Title of the operation being run right now. */
  private running: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly simulations = new SimulationCache();
  private readonly onDidChangeEmitter = new Emitter<UndoInfo>();
  /** Fires when the journal changes (labels for Undo/Redo). */
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly repo: Repository,
    private readonly data: RepoData,
    private readonly options: RepoOperationsOptions = {},
  ) {
    const saved = options.store?.load();
    this.undoStack = saved?.undo ?? [];
    this.redoStack = saved?.redo ?? [];
    this.pending = saved?.pending;
    this.stop = saved?.stop;
    this.journalId = saved?.id && /^[0-9a-f-]{36}$/.test(saved.id) ? saved.id : randomUUID();
  }

  get undoInfo(): UndoInfo {
    return { undo: this.undoStack.at(-1)?.title, redo: this.redoStack.at(-1)?.title };
  }

  async opState(): Promise<OpState> {
    const running = this.running;
    const read = await this.withStopReason(
      await withSubmoduleConflicts(this.repo, await readOpState(this.repo)),
    );
    if (running) return { ...read, running };
    if (!read.kind && this.pending) await this.enqueue(() => this.settlePending());
    const started = await this.startedHere(read);
    const state = started ? { ...read, started } : read;
    // At an edit stop, while splitting, and while applying patches, what is staged decides what
    // Continue does.
    if (state.editStop || state.kind === 'am' || state.split) {
      const tree = await this.data.workingTree();
      return {
        ...state,
        changes: { staged: tree.staged, unstaged: tree.unstaged, untracked: tree.untracked },
      };
    }
    return state;
  }

  /** A failed step with git's reason, kept from when Lanefold ran it (if that is this stop). */
  private async withStopReason(state: OpState): Promise<OpState> {
    const reason = this.stop?.reason;
    if (!state.failedStep || !reason) return state;
    const origin = await operationOrigin(this.repo, state).catch(() => undefined);
    return origin === this.stop?.origin ? { ...state, failedStep: { ...state.failedStep, reason } } : state;
  }

  /** The operation Lanefold started that git is stopped in (when that is the one in progress). */
  private async startedHere(state: OpState): Promise<OpState['started']> {
    const pending = this.pending;
    if (!state.kind || !pending?.origin) return undefined;
    const origin = await operationOrigin(this.repo, state).catch(() => undefined);
    return origin === pending.origin ? { kind: pending.kind, title: pending.title } : undefined;
  }

  async plan(operation: Operation): Promise<OperationPlan> {
    const [state, head, refs, opState, workingTree] = await Promise.all([
      readRefState(this.repo),
      this.repo.head(),
      this.data.refs(),
      readOpState(this.repo),
      this.data.workingTree(),
    ]);
    const record = await planOperation(
      {
        repo: this.repo,
        state,
        head,
        refs,
        opState: await this.withStopReason(opState),
        workingTree,
        canRewrite: !!this.options.rebaseScript,
        rebaseScript: this.options.rebaseScript,
        worktreeChanges: () => this.data.worktreeChanges(),
        stop: opState.kind ? this.stop : undefined,
        started: await this.startedHere(opState),
      },
      operation,
    );
    const now = Date.now();
    for (const [id, old] of this.plans) if (now - old.created > PLAN_TTL_MS) this.plans.delete(id);
    this.plans.set(record.plan.id, { ...record, created: now });
    return record.plan;
  }

  /** The commits a history edit after `base` would cover (for the editor). */
  rewriteRange(base: string | null): Promise<RewriteRange | undefined> {
    return readRewriteRange(this.repo, base);
  }

  /** Dry-runs a history edit: which step would conflict or become empty. */
  async simulate(
    base: string | null,
    entries: readonly RewriteEntry[],
    signal?: AbortSignal,
  ): Promise<RewriteSimulation> {
    const range = await readRewriteRange(this.repo, base);
    if (!range || range.tooMany || range.merges > 0) return { supported: false, steps: [] };
    return simulateRewrite(this.repo, range, entries, this.simulations, signal);
  }

  /** Runs a plan (serialized with other operations on this repository). */
  execute(planId: string): Promise<OperationResult> {
    return this.enqueue(() =>
      this.busy(this.plans.get(planId)?.plan.title ?? 'Operation', () => this.run(planId)),
    );
  }

  /** Undoes the last journaled operation; with `entryId`, only if it is still that one. */
  undo(entryId?: string): Promise<OperationResult> {
    return this.enqueue(() => this.busy('Undo', () => this.travel('undo', entryId)));
  }

  redo(): Promise<OperationResult> {
    return this.enqueue(() => this.busy('Redo', () => this.travel('redo')));
  }

  private async busy<T>(title: string, task: () => Promise<T>): Promise<T> {
    this.running = title;
    try {
      return await task();
    } finally {
      this.running = undefined;
    }
  }

  /**
   * Runs a task once the operations queued before it are done: what else changes the index
   * (staging, marking files resolved) must not run in the middle of an operation.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private refused(title: string, message: string, errorKind?: string): OperationResult {
    return { status: 'refused', title, message, errorKind };
  }

  /** Waits briefly for another git process to release index.lock. */
  private async waitForLock(): Promise<boolean> {
    const lock = this.repo.gitPath('index.lock');
    for (let waited = 0; existsSync(lock); waited += 100) {
      if (waited >= LOCK_WAIT_MS) return false;
      await sleep(100);
    }
    return true;
  }

  private async run(planId: string): Promise<OperationResult> {
    const record = this.plans.get(planId);
    if (!record) return this.refused('Operation', 'This plan expired. Review the operation again.', 'stale');
    this.plans.delete(planId);
    const { plan } = record;
    if (plan.blocked)
      return this.refused(
        plan.title,
        plan.notices.find((n) => n.level === 'danger')?.text ?? 'Not possible.',
      );
    if (plan.commands.length === 0) return this.refused(plan.title, 'There is nothing to run.');

    // Optimistic concurrency: nothing may have changed since the plan was made.
    const [before, opState] = await Promise.all([readRefState(this.repo), readOpState(this.repo)]);
    if (!sameState(before, record.expected)) {
      return this.refused(
        plan.title,
        'The repository changed since this was planned. Review the operation again.',
        'stale',
      );
    }
    if (record.requiresOpState === 'none' ? opState.kind : opState.kind !== record.requiresOpState) {
      return this.refused(
        plan.title,
        opState.kind
          ? `A ${opState.kind} is in progress. Continue or abort it first.`
          : 'The operation is no longer in progress.',
        'operationInProgress',
      );
    }
    if (!(await this.waitForLock())) {
      return this.refused(
        plan.title,
        'Another git process is using the repository (index.lock exists).',
        'lockFile',
      );
    }
    for (const { rev, sha } of record.pinned ?? []) {
      if ((await resolveCommit(this.repo, rev)) !== sha) {
        return this.refused(
          plan.title,
          `${rev} moved since this was planned (a fetch, say). Review the operation again.`,
          'stale',
        );
      }
    }
    // A commit while splitting is a step of the stopped history edit, like Continue.
    const control = isControl(plan.operation) || !!record.duringStop;
    // A stopped operation that finished or was aborted outside Lanefold.
    if (!control && this.pending) await this.settlePending();
    // Continue/abort/skip finish the stopped operation only if it is the one in progress.
    if (control && this.pending && this.pending.origin !== (await operationOrigin(this.repo, opState)))
      this.setPending(undefined);

    let snapshot: string | undefined;
    let filesBefore: WorkState | undefined;
    let stashBefore: string | undefined;
    /** Changes git is about to discard (abort, skip), saved on the stash list first. */
    let savedWork = false;
    try {
      if (record.snapshot)
        snapshot = await takeSnapshot(this.repo, plan.title, this.journalId, record.snapshotIgnored);
      if (record.exactUndo) filesBefore = await readWorkState(this.repo);
      if (record.stash?.creates || record.carries) stashBefore = await stashTop(this.repo);
      if (record.protectWork && (await workSinceStop(this.repo, opState, this.stop))) {
        const work = await takeSnapshot(this.repo, plan.title);
        await saveSnapshotAsStash(this.repo, work, `Lanefold: changes saved before ${quote(plan.title)}`);
        savedWork = true;
      }
    } catch (error) {
      return this.refused(
        plan.title,
        `Lanefold could not save a safety snapshot first, so nothing was done: ${describeError(error)}`,
        'snapshotFailed',
      );
    }
    // Right before running: the stash it acts on must still be where it was (the snapshots took
    // a moment, and another tool may have stashed meanwhile).
    const target = record.stash?.target;
    if (target && (await stashAt(this.repo, target.index)) !== target.sha) {
      return this.refused(
        plan.title,
        'The stash list changed since this was planned. Review the operation again.',
        'stale',
      );
    }
    // Likewise what the plan was built from (a file's diff, for a patch of some of its lines).
    const changed = await record.recheck?.();
    if (changed) return this.refused(plan.title, changed, 'stale');
    // A fetch, pull or push moves remote branches the journal does not compare: read them first,
    // to tell afterwards what happened.
    const syncBefore = isSyncOperation(plan.operation)
      ? await readSyncRefs(this.repo).catch(() => undefined)
      : undefined;

    const env = { ...record.env, GIT_REFLOG_ACTION: `lanefold: ${plan.title}` };
    // Git's --autostash brings uncommitted changes back unstaged: what was staged is noted, to
    // be staged again once the operation is through.
    const autostash = (
      record.rewrite?.args ?? (record.commands ?? plan.commands).flatMap((c) => c.args)
    ).includes('--autostash');
    const stagedBefore = autostash ? await stagedEntries(this.repo, plan.title).catch(() => []) : [];
    let failure: unknown;
    /** What git wrote before giving up half-way, put back (undefined: nothing to put back). */
    let halfDone: HalfDone | undefined;
    let halfDoneTried = false;
    const putBack = async (error: unknown) => {
      halfDoneTried = true;
      halfDone = await this.putBackHalfDone(error, plan, record, before, snapshot, stashBefore, env);
    };
    /** What the commands that went through printed: files they could not replace, say. */
    const printed: string[] = [];
    /** The planned command that failed, by index (none ran when it is undefined). */
    let failedAt: number | undefined;
    try {
      if (record.rewrite) await this.runRewrite(record, env);
      else if (record.split) await runSplitStep(this.repo, record.split, { env, label: plan.title });
      else {
        let output: Buffer | undefined;
        // As planned, with any credentials in URLs (the plan shown has them hidden).
        for (const [index, command] of (record.commands ?? plan.commands).entries()) {
          const stdin = command.pipe ? output : record.stdin?.[index];
          const run = async (args: readonly string[]) => {
            const result = await this.repo.gitBuffer(args, { env, label: plan.title, stdin });
            printed.push(result.stderr);
            return result.stdout;
          };
          try {
            output = await run(command.args);
          } catch (error) {
            // Another way to the same end (it may fail too; conflicts left behind rule it out).
            if (command.fallback && (await conflictedPaths(this.repo)).length === 0) {
              output = await run(command.fallback);
              continue;
            }
            const stopped = !!(await readOpState(this.repo)).kind;
            // Git gave up half-way, unable to replace a file: what it had written goes back first
            // (then what the steps before set aside comes back onto the files as they were).
            if (!stopped) await putBack(error);
            // Put back what the steps before set aside (the failure still ends the operation) —
            // unless git stopped in the middle (a conflict): that waits until it is done.
            if (command.onFailure && !stopped)
              await this.repo.git([...command.onFailure], { env, label: plan.title }).catch(() => undefined);
            failedAt = index;
            throw error;
          }
        }
      }
    } catch (error) {
      failure = error;
      // A history edit that could not start: it checks out where it starts first.
      if (!halfDoneTried && !(await readOpState(this.repo)).kind) await putBack(error);
    }
    // A branch to delete from a remote that the remote had deleted already (the lease expected
    // it where it was last fetched): what was asked for is done.
    const goneAlready =
      failure instanceof GitError
        ? await deletedAlready(this.repo, plan, failure, plan.title).catch(() => undefined)
        : undefined;
    if (goneAlready) failure = undefined;
    // Files git went on past (a checkout does), with their old content still.
    const stale = await staleFiles(this.repo, printed.join('\n'), before.head, { env, label: plan.title });
    // Git stopped at a commit to split: take it apart right away (that is what the plan said).
    const opened =
      !failure && (record.rewrite || isControl(plan.operation)) && (await this.openSplit(env, plan.title));

    if (plan.operation.kind === 'setIdentity') {
      // Settings, not history: whatever git is in the middle of stays as it was (and recorded).
      const error = failure instanceof GitError ? failure : undefined;
      return failure
        ? {
            status: 'failed',
            title: plan.title,
            message: error ? describeGitFailure(error) : String(failure),
            errorKind: error?.kind,
          }
        : {
            status: 'done',
            title: plan.title,
            outcome: record.outcome,
            message: 'Git now records commits with your name and email.',
          };
    }
    if (isRemoteOperation(plan.operation)) {
      // Settings and remote branches, not history: nothing to journal, so say what changed.
      const error = failure instanceof GitError ? failure : undefined;
      const result = await remoteResult(
        this.repo,
        plan.operation,
        plan.title,
        failure === undefined
          ? undefined
          : { message: error ? describeGitFailure(error) : String(failure), kind: error?.kind },
      );
      return result.status === 'done' ? { ...result, outcome: pastTense(plan.title) } : result;
    }
    const [after, stateAfter] = await Promise.all([readRefState(this.repo), readOpState(this.repo)]);
    if (!failure && !stateAfter.kind && stagedBefore.length > 0)
      await restageAfterAutostash(this.repo, stagedBefore, before.head, after.head, plan.title).catch(
        () => undefined,
      );
    if (stateAfter.kind === 'bisect' && NOT_JOURNALED.has(plan.operation.kind) && !failure) {
      // Bisecting goes on until it is stopped: not an operation that stopped half-way.
      const bisect = stateAfter.bisect;
      return {
        status: 'done',
        title: plan.title,
        outcome: record.outcome ?? pastTense(plan.title),
        message:
          (bisect?.firstBad
            ? `Found it: ${short(bisect.firstBad)} “${bisect.firstBadSubject ?? ''}” is the first bad commit.`
            : `Testing ${short(bisect?.current)}: ${bisect?.remaining ?? 0} suspects left, about ${bisect?.steps ?? 0} more tests.`) +
          (stale ? ` ${describeStaleFiles(stale)}` : ''),
        ...(stale ? { errorKind: 'fileInUse', files: stale.map((file) => file.path) } : {}),
      };
    }
    if (stateAfter.kind) {
      // Stopped in the middle (conflicts, or an `edit` line): it becomes undoable as a whole once
      // it finishes. What git left is recorded, to tell later whether anything was changed since.
      const origin = await operationOrigin(this.repo, stateAfter);
      // Changes it set aside wait on the stash list until it is done or aborted (a step of it
      // that stops again still has them waiting).
      const carried = control
        ? this.pending?.carried
        : record.carries
          ? await this.setAside(stashBefore)
          : undefined;
      // A step git could not carry out: why, in plain words (kept from the run of the step; an
      // abort or skip that failed tells its own reason in its result).
      const ranStep = !control || plan.operation.kind === 'continue';
      const previous = this.stop;
      const reason = stateAfter.failedStep
        ? ranStep && failure !== undefined
          ? failureText(failure)
          : previous && previous.origin === origin
            ? previous.reason
            : undefined
        : undefined;
      this.stop = {
        origin,
        files: await readWorkState(this.repo).catch(() => ({ index: '', worktree: '' })),
        ...(reason ? { reason } : {}),
      };
      if (!control)
        this.setPending({
          title: plan.title,
          kind: plan.operation.kind,
          time: Date.now(),
          before,
          origin,
          snapshot,
          rewrite: record.rewrite && rewriteInfo(record),
          moves: movedAlong(plan, before),
          carried,
        });
      // A Retry starts a sequence of picks again (which then starts from HEAD): still the
      // operation the user started.
      else if (this.pending && this.pending.origin !== origin) this.setPending({ ...this.pending, origin });
      else this.persist();
      // A part committed while splitting (the history edit goes on), or a split step git refused
      // (a hook, say): git's own words tell what happened.
      if (record.duringStop || (record.split && failure && stateAfter.conflicts.length === 0))
        return stepResult(plan.title, failure, after.head);
      // Continue, Skip or Abort that got nowhere (git refused, or the same step failed again):
      // a failure, in git's words.
      if (
        control &&
        failure !== undefined &&
        opState.kind === stateAfter.kind &&
        opState.step === stateAfter.step &&
        stateAfter.conflicts.length === 0 &&
        sameState(before, after)
      ) {
        const error = failure instanceof GitError ? failure : undefined;
        return {
          status: 'failed',
          title: plan.title,
          message: failureText(failure),
          errorKind: error?.kind,
          files: error?.files,
        };
      }
      const conflicts = stateAfter.conflicts.length;
      const split = stateAfter.split;
      const failedStep = stateAfter.failedStep;
      return {
        status: conflicts > 0 ? 'conflicts' : 'stopped',
        title: plan.title,
        // A step git could not carry out is a failure, though git stopped in the middle.
        ...(failedStep && failure instanceof GitError
          ? { errorKind: failure.kind, files: failure.files }
          : {}),
        message:
          (conflicts > 0
            ? `Stopped on ${conflicts} conflicted file${conflicts === 1 ? '' : 's'}.`
            : split?.opened && (opened || plan.operation.kind === 'startSplit')
              ? `Splitting ${short(split.commit)}: its changes are uncommitted now. Stage and commit them in parts, then continue.`
              : split && stateAfter.editStop
                ? `Stopped at ${short(split.commit)} to split it.`
                : stateAfter.editStop
                  ? `Stopped at ${short(stateAfter.commit)} so you can change it.`
                  : failedStep
                    ? `Could not apply ${short(failedStep.commit)}${failedStep.subject ? ` “${failedStep.subject}”` : ''}: ${reason ?? 'git did not say why (the Git Console shows what it printed).'}`
                    : `The ${stateAfter.kind} stopped.`) +
          (carried ? CARRIED_WAIT : '') +
          (savedWork ? SAVED_WORK : ''),
        conflicts: stateAfter.conflicts,
      };
    }
    if (this.stop) {
      this.stop = undefined;
      this.persist();
    }
    // The operation that stopped is over (done or aborted): what it set aside comes back.
    const carriedBack =
      control && this.pending?.carried
        ? await this.bringBack(this.pending.carried, env, plan.title)
        : undefined;

    const stash = await this.stashChange(record.stash, stashBefore);
    const filesAfter = record.exactUndo ? await readWorkState(this.repo) : undefined;
    const pathsAfter =
      record.restorePaths && snapshot ? await fingerprintPaths(this.repo, record.restorePaths) : undefined;
    let entry: JournalEntry | undefined;
    let rewritten: Record<string, string> | undefined;
    const pending = control ? this.pending : undefined;
    if (pending) {
      // The operation that stopped is over: finished (journal it whole) or aborted.
      this.setPending(undefined);
      if (plan.operation.kind !== 'abort' && !sameState(pending.before, after)) {
        entry = entryFrom(pending, after);
        // Its changes came back on top: Undo puts the files back exactly as they were before.
        if (pending.carried && pending.snapshot)
          entry = { ...entry, afterFiles: await readWorkState(this.repo) };
        if (pending.rewrite) rewritten = await this.mapRewritten(pending.rewrite);
      }
    } else if (control && opState.kind === 'rebase') {
      // A rebase started outside Lanefold: undoing just its last step would leave a detached
      // mid-rebase HEAD, so it is not journaled.
    } else if (control && opState.kind === 'bisect') {
      // Stopping a bisect returns HEAD to where it was: nothing to undo.
    } else if (
      (!sameState(before, after) ||
        stash !== undefined ||
        // Failed half-way, and all that git wrote is back: the files are as they were.
        (!(halfDone && halfDone.left.length === 0) &&
          (record.exactUndo ? !sameWorkState(filesBefore, filesAfter) : snapshot !== undefined))) &&
      !NOT_JOURNALED.has(plan.operation.kind)
    ) {
      entry = {
        id: randomUUID(),
        title: plan.title,
        kind: plan.operation.kind,
        time: Date.now(),
        before,
        after,
        snapshot,
        paths: record.restorePaths,
        pathsAfter,
        stash,
        afterFiles: filesAfter,
        branchSettings: record.branchSettings,
      };
      if (record.rewrite && !failure) rewritten = await this.mapRewritten(rewriteInfo(record));
    }
    if (entry) this.record(entry);

    if (!failure && carriedBack?.conflicts.length) {
      // Done, but the changes it set aside conflict with the result: they stay on the list too.
      return {
        status: 'conflicts',
        title: entry?.title ?? plan.title,
        message: `${pastTense(entry?.title ?? plan.title)}; your changes conflict with the result in ${plural(carriedBack.conflicts.length, 'file')}. Resolve them (they are also kept on the stash list), or Undo.`,
        entry,
        conflicts: carriedBack.conflicts,
      };
    }
    if (!failure) {
      const counts = plan.rewrite
        ? `${plural(plan.rewrite.before, 'commit')} → ${plan.rewrite.after} · `
        : '';
      const synced = isSyncOperation(plan.operation)
        ? (goneAlready ??
          (syncBefore &&
            (await syncMessage(this.repo, plan, syncBefore, before, after).catch(() => undefined))))
        : undefined;
      const title = entry?.title ?? plan.title;
      const from = pending?.before ?? before;
      const refs = describeDone(from, after);
      const message =
        (stashMessage(plan.operation, stash) ??
          submoduleMessage(plan.operation) ??
          record.doneMessage ??
          synced ??
          // Files changed, not refs (a discard): the headline says it all.
          sentences(`${counts}${entry && refs === NOTHING_CHANGED ? '' : refs}`, goneAlready)) +
        (carriedBack ? CARRIED_BACK : '') +
        (savedWork ? SAVED_WORK : '');
      return {
        status: 'done',
        title,
        // A sync says what it did in its message; otherwise the title, in the past tense.
        outcome: synced
          ? firstSentence(synced)
          : ((pending ? undefined : record.outcome) ?? pastTense(title)),
        message: stale ? [message, describeStaleFiles(stale)].filter(Boolean).join(' ') : message,
        // Done, but with files it could not update: the toast says so, and offers to finish.
        ...(stale ? { errorKind: 'fileInUse', files: stale.map((file) => file.path) } : {}),
        entry,
        rewritten,
        // Taken off a branch (or a commit checked out): on no branch now, which is worth a word.
        detached:
          !after.branch &&
          after.head &&
          headMoved(from, after) &&
          (from.branch !== undefined || plan.operation.kind === 'checkout')
            ? after.head
            : undefined,
      };
    }
    if (record.carries) {
      const conflicted = (await this.data.worktreeChanges()).conflicted.map((file) => file.path);
      if (conflicted.length > 0) {
        return {
          status: 'conflicts',
          title: plan.title,
          message:
            (plan.operation.kind === 'checkout'
              ? `Switched; your changes conflict with the new branch in ${plural(conflicted.length, 'file')}. Resolve them (they are also kept on the stash list), or Undo.`
              : `${pastTense(plan.title)}; your changes conflict with the result in ${plural(conflicted.length, 'file')}. Resolve them (they are also kept on the stash list), or Undo.`) +
            (stale ? ` ${describeStaleFiles(stale)}` : ''),
          entry,
          conflicts: conflicted,
        };
      }
    }
    if (
      plan.operation.kind === 'stashApply' ||
      plan.operation.kind === 'applyFileChanges' ||
      (plan.operation.kind === 'applyPatch' && !plan.operation.commit)
    ) {
      // Git applies what it can and leaves conflict markers (a stash stays on the list).
      const conflicted = (await this.data.worktreeChanges()).conflicted.map((file) => file.path);
      if (conflicted.length > 0) {
        return {
          status: 'conflicts',
          title: plan.title,
          message: `Applied with conflicts in ${conflicted.length} file${conflicted.length === 1 ? '' : 's'}${plan.operation.kind === 'stashApply' ? '; the stash stays on the list' : ''}. Resolve them, or Undo.`,
          entry,
          conflicts: conflicted,
        };
      }
    }
    const error = failure instanceof GitError ? failure : undefined;
    // In a submodule, git's words name files of another repository: say where.
    const inSubmodule = error && submoduleFailure(plan.operation, error);
    // A fetch of every remote goes on past one that fails: say what the others brought.
    const partly =
      syncBefore && (await fetchedDespiteFailure(this.repo, plan, syncBefore).catch(() => undefined));
    // A squash merge is two steps: when the commit fails (a hook, signing), the merged changes
    // are left staged.
    const squashLeft =
      plan.operation.kind === 'merge' &&
      plan.operation.strategy === 'squash' &&
      (await this.data.worktreeChanges().catch(() => undefined))?.staged.length
        ? ' The squashed changes are staged: commit them yourself, or discard them.'
        : '';
    const reason = inSubmodule || (error ? describeGitFailure(error) : String(failure));
    // What the steps before the one that failed did, which git does not take back: said first.
    const doneFirst = failedAt === undefined ? undefined : record.doneFirst?.[failedAt];
    return {
      status: 'failed',
      title: plan.title,
      message:
        (doneFirst ? sentences(doneFirst, capitalized(reason.replace(/^Not deleted: /, ''))) : reason) +
        (halfDone?.putBack.length ? ` ${PUT_BACK}` : '') +
        squashLeft +
        (partly ? ` ${partly}` : ''),
      entry,
      errorKind: inSubmodule ? 'submodule' : error?.kind,
      files: error?.files,
    };
  }

  /**
   * After git gave up half-way, unable to replace a file (see halfDone): puts back what it had
   * written, if HEAD is still where it was. A stash it had made of the changes goes once they
   * are all back (it holds nothing else).
   */
  private async putBackHalfDone(
    error: unknown,
    plan: OperationPlan,
    record: PlanRecord,
    before: RefState,
    snapshot: string | undefined,
    stashBefore: string | undefined,
    env: Record<string, string>,
  ): Promise<HalfDone | undefined> {
    if (!(error instanceof GitError) || error.kind !== 'fileInUse') return undefined;
    try {
      const now = await readRefState(this.repo);
      if (!before.head || now.head !== before.head || now.branch !== before.branch) return undefined;
      const done = await putBackHalfDone(this.repo, {
        // Changes a plan carries are set aside first: the files go back to HEAD, and the
        // changes come back after.
        snapshot: record.carries ? undefined : snapshot,
        versions: await writtenVersions(this.repo, plan.operation, before.head).catch(() => []),
        env,
        label: plan.title,
      });
      if (done && done.left.length === 0 && plan.operation.kind === 'stashPush') {
        const top = await stashTop(this.repo);
        if (top && top !== stashBefore)
          await this.repo.git(['stash', 'drop', '--quiet', 'stash@{0}'], { env, label: plan.title });
      }
      return done;
    } catch {
      return undefined;
    }
  }

  /** The stash a plan that carries changes made before git stopped (on top since `before`). */
  private async setAside(before: string | undefined): Promise<string | undefined> {
    const top = await stashTop(this.repo).catch(() => undefined);
    return top && top !== before ? top : undefined;
  }

  /**
   * Brings back changes set aside for an operation that stopped, now that it is over: the stash
   * is popped (what was staged staged again where possible). Conflicts with the result leave
   * markers, and the stash stays on the list.
   */
  private async bringBack(
    sha: string,
    env: Record<string, string>,
    label: string,
  ): Promise<{ readonly conflicts: readonly string[] } | undefined> {
    const entry = (await readStashList(this.repo).catch(() => [])).find((stash) => stash.sha === sha);
    if (!entry) return undefined;
    const ref = `stash@{${entry.index}}`;
    try {
      await this.repo.git(['stash', 'pop', '--index', ref], { env, label });
    } catch {
      // Staged changes that cannot be staged again come back unstaged.
      if ((await conflictedPaths(this.repo)).length === 0)
        await this.repo.git(['stash', 'pop', ref], { env, label }).catch(() => undefined);
    }
    return { conflicts: await conflictedPaths(this.repo) };
  }

  /** What a stash operation actually did to the stash list (it may have failed half-way). */
  private async stashChange(
    effect: PlanRecord['stash'],
    topBefore: string | undefined,
  ): Promise<StashChange | undefined> {
    if (effect?.creates) {
      const top = await stashTop(this.repo);
      return top && top !== topBefore ? { created: top } : undefined;
    }
    const target = effect?.target;
    if (effect?.removes && target) {
      const list = await readStashList(this.repo);
      if (!list.some((stash) => stash.sha === target.sha))
        return { removed: { sha: target.sha, subject: target.subject } };
    }
    return undefined;
  }

  private async runRewrite(record: PlanRecord, env: Record<string, string>): Promise<void> {
    const script = this.options.rebaseScript;
    const rewrite = record.rewrite!;
    if (!script) throw new Error('History editing is not available.');
    const messages = new Map(rewrite.range.commits.map((commit) => [commit.sha, commit.message]));
    const info = rewriteInfo(record);
    await runPlannedRebase(this.repo, script, {
      args: ['-i', ...rewrite.args.filter((arg) => arg !== '-i')],
      expected: rewrite.range.commits.map((commit) => commit.sha),
      entries: rewrite.entries,
      messageOf: (sha) => messages.get(sha),
      env,
      label: record.plan.title,
      // The sequence editor leaves this in rebase-merge/: it tells which `edit` stops are splits.
      info: { title: record.plan.title, base: info.base, groups: info.groups, splits: info.splits },
    });
  }

  /**
   * After a step Lanefold ran stopped at a commit to split: takes it apart (HEAD back to its
   * parent, its changes uncommitted). True when it did; a failure leaves the commit whole, and
   * the banner offers to try again.
   */
  private async openSplit(env: Record<string, string>, title: string): Promise<boolean> {
    // Only history edits split commits (most steps are not stopped in one).
    if (!existsSync(this.repo.gitPath(`rebase-merge/${HISTORY_EDIT_MARKER}`))) return false;
    try {
      const state = await readOpState(this.repo);
      const split = state.split;
      if (!split || split.opened || !state.editStop) return false;
      const [stopped, head] = await Promise.all([editStopCommit(this.repo), this.repo.head()]);
      if (!stopped || stopped !== head.sha) return false;
      await runSplitStep(
        this.repo,
        { step: 'open', commit: split.commit, from: 'commit' },
        { env, label: title },
      );
      return true;
    } catch {
      return false;
    }
  }

  private mapRewritten(info: NonNullable<PendingEntry['rewrite']>) {
    return mapRewritten(this.repo, info.base, info.groups, (sha) => info.authors[sha], info.splits).catch(
      () => undefined,
    );
  }

  private setPending(pending: PendingEntry | undefined): void {
    this.pending = pending;
    this.persist();
  }

  /**
   * The operation that stopped is no longer in progress, but it was not finished through
   * Lanefold (a terminal `git rebase --continue`, say). A history edit or rebase that evidently
   * finished — HEAD back on its branch, whose last reflog entry is the rebase's "finish" — is
   * journaled; anything else is forgotten (Undo could otherwise take newer work with it).
   */
  private async settlePending(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    const opState = await readOpState(this.repo);
    if (opState.kind) return;
    this.pending = undefined;
    this.stop = undefined;
    const after = await readRefState(this.repo);
    const branch = pending.before.branch;
    const ref = branch ? `refs/heads/${branch}` : undefined;
    if (
      (pending.kind === 'rewrite' || pending.kind === 'rebase' || pending.kind === 'pull') &&
      ref &&
      after.branch === branch &&
      !sameState(pending.before, after)
    ) {
      // Only that very rebase finishing: its last step moved the branch away from where the
      // stopped rebase started (any other rebase started from another commit).
      const [reflog, previous] = await Promise.all([
        this.repo
          .git(['reflog', '-1', '--format=%gs', ref], {
            readOnly: true,
            background: true,
            okExitCodes: [0, 128],
          })
          .then((result) => result.stdout.trim())
          .catch(() => ''),
        resolveCommit(this.repo, `${ref}@{1}`),
      ]);
      // git's finish entry names where the rebase put the branch: "… (finish): <ref> onto <sha>".
      const onto = /\(finish\): \S+ onto ([0-9a-f]+)$/.exec(reflog)?.[1];
      const [origHead, plannedOnto] = (pending.origin ?? '').split('+');
      if (onto && onto === plannedOnto && previous === origHead && previous === pending.before.refs[ref]) {
        this.record(entryFrom(pending, after));
        return;
      }
    }
    this.persist();
  }

  private record(entry: JournalEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > JOURNAL_LIMIT)
      this.undoStack.splice(0, this.undoStack.length - JOURNAL_LIMIT);
    this.redoStack = [];
    this.persist();
  }

  private persist(): void {
    this.options.store?.save({
      id: this.journalId,
      undo: this.undoStack,
      redo: this.redoStack,
      pending: this.pending,
      stop: this.stop,
    });
    this.onDidChangeEmitter.fire(this.undoInfo);
    // Snapshots no entry can restore any more need not be kept (git expires them in time).
    const needed = new Set(
      [...this.undoStack, ...this.redoStack, this.pending].flatMap((entry) =>
        entry?.snapshot ? [entry.snapshot] : [],
      ),
    );
    void releaseSnapshots(this.repo, this.journalId, needed).catch(() => undefined);
  }

  /**
   * Undo/redo: puts refs and HEAD back to an entry's `before` (or `after`) state, but only if
   * the repository is still exactly in the state the entry left it in.
   */
  private async travel(direction: 'undo' | 'redo', entryId?: string): Promise<OperationResult> {
    const stack = direction === 'undo' ? this.undoStack : this.redoStack;
    const verb = direction === 'undo' ? 'Undo' : 'Redo';
    const [current, opState] = await Promise.all([readRefState(this.repo), readOpState(this.repo)]);
    if (opState.kind)
      return this.refused(
        stack.at(-1) ? `${verb}: ${stack.at(-1)!.title}` : verb,
        `A ${opState.kind} is in progress. Continue or abort it first.`,
        'operationInProgress',
      );
    const settled = !!this.pending;
    if (settled) await this.settlePending();
    const last = stack.at(-1);
    if (entryId !== undefined && last?.id !== entryId) {
      return this.refused(
        verb,
        last
          ? `${quote(last.title)} was done since. Undo that first (the Undo button at the top steps back one operation at a time).`
          : 'That operation can no longer be undone.',
        'stale',
      );
    }
    return this.travelTo(direction, settled ? await readRefState(this.repo) : current);
  }

  private async travelTo(direction: 'undo' | 'redo', current: RefState): Promise<OperationResult> {
    const stack = direction === 'undo' ? this.undoStack : this.redoStack;
    const entry = stack.at(-1);
    const verb = direction === 'undo' ? 'Undo' : 'Redo';
    if (!entry) return this.refused(verb, `Nothing to ${direction}.`);
    const title = `${verb}: ${entry.title}`;
    const from = direction === 'undo' ? entry.after : entry.before;
    const to = direction === 'undo' ? entry.before : entry.after;

    if (!sameState(current, from)) {
      return this.refused(
        title,
        `The repository changed since ${quote(entry.title)} (${describeChanges(from, current)}). ${verb} could lose that work, so it was not done.`,
        'stale',
      );
    }
    // A branch checked out in another worktree is that worktree's: moving it would change the
    // commit under its files.
    const elsewhere = await this.checkedOutElsewhere();
    const busy = diffRefStates(current, to).find((change) => elsewhere.has(change.ref));
    if (busy) {
      return this.refused(
        title,
        `${shortRef(busy.ref)} is checked out in another worktree (${elsewhere.get(busy.ref)}); ${verb} would change it under that worktree.`,
        'branchInWorktree',
      );
    }
    if (
      entry.snapshot &&
      (direction === 'undo' || entry.afterFiles) &&
      !(await snapshotExists(this.repo, entry.snapshot))
    ) {
      return this.refused(
        title,
        `The safety snapshot of ${quote(entry.title)} is no longer in the repository, so ${verb} cannot bring the files back.`,
        'snapshotGone',
      );
    }
    if (entry.stash || entry.afterFiles) return this.undoExact(entry, title);
    const restoreFiles = direction === 'undo' && entry.snapshot;
    let untrackedSaved = false;
    if (restoreFiles && entry.paths && entry.pathsAfter) {
      // Some files come back: only those must be exactly as the operation left them.
      const now = await fingerprintPaths(this.repo, entry.paths);
      const changed = entry.paths.find((path) => now[path] !== entry.pathsAfter![path]);
      if (changed) {
        return this.refused(
          title,
          `${changed} changed since ${quote(entry.title)}; Undo would overwrite that. Commit or stash it first.`,
          'dirtyWorkTree',
        );
      }
    } else if (restoreFiles && entry.paths) {
      // A discard of some files: only those come back, so only those must be untouched since.
      const changes = await this.data.worktreeChanges();
      const touched = new Set(
        [...changes.unstaged, ...changes.untracked, ...changes.conflicted].map((file) => file.path),
      );
      const busy = entry.paths.find((path) => touched.has(path));
      if (busy) {
        return this.refused(
          title,
          `${busy} changed since the discard; Undo would overwrite that. Commit or stash it first.`,
          'dirtyWorkTree',
        );
      }
    } else if (restoreFiles) {
      const tree = await this.data.workingTree();
      if (tree.staged + tree.unstaged + tree.conflicted > 0) {
        return this.refused(title, 'Commit or stash the changes you made since, then undo.', 'dirtyWorkTree');
      }
      // Untracked files survive the reset; one could be overwritten by the restore, so keep a
      // snapshot of them too.
      if (tree.untracked > 0) {
        await takeSnapshot(this.repo, `undo of ${entry.title}`);
        untrackedSaved = true;
      }
    }
    if (!(await this.waitForLock()))
      return this.refused(
        title,
        'Another git process is using the repository (index.lock exists).',
        'lockFile',
      );

    const renamed = entry.kind === 'renameBranch' ? renamedBranches(from, to) : undefined;
    let moved = false;
    /** What git printed switching: files it could not replace, say. */
    let printed = '';
    try {
      // A rename moves the branch's config (upstream) and reflog too: rename back, not re-create.
      if (renamed)
        await this.repo.git(['branch', '-m', '--end-of-options', renamed.from, renamed.to], { label: title });
      // Undoing a commit, or an amend with staged changes, brings those changes back as staged.
      else
        printed = await moveRefs(
          this.repo,
          current,
          to,
          `lanefold: ${title}`,
          entry.kind === 'commit' || entry.kind === 'amendInto',
        );
      moved = true;
      // Branches it deleted come back with their settings (their upstream); Redo deletes those
      // again, as git did. The branches matter most: the settings are put back as far as they go.
      if (entry.branchSettings)
        await this.settleBranchSettings(entry.branchSettings, to, title).catch(() => undefined);
      if (restoreFiles && entry.paths) await restorePaths(this.repo, entry.snapshot!, entry.paths);
      else if (restoreFiles) await restoreSnapshot(this.repo, entry.snapshot!);
    } catch (error) {
      // Files that cannot come back must not leave the refs moved: all or nothing.
      if (moved) {
        if (renamed)
          await this.repo
            .git(['branch', '-m', '--end-of-options', renamed.to, renamed.from], { label: title })
            .catch(() => undefined);
        else
          await readRefState(this.repo)
            .then((now) => moveRefs(this.repo, now, from, `lanefold: rollback of ${title}`))
            .catch(() => undefined);
      }
      const gitError = error instanceof GitError ? error : undefined;
      return {
        status: 'failed',
        title,
        message: gitError ? describeGitFailure(gitError) : String(error),
        errorKind: gitError?.kind,
        files: gitError?.files,
      };
    }
    stack.pop();
    // A discard is not redone (the files are simply discarded again if wanted).
    const discard =
      entry.kind === 'discard' || entry.kind === 'restoreFiles' || entry.kind === 'discardLines';
    const redoable = !(direction === 'undo' && entry.paths && discard);
    if (redoable) (direction === 'undo' ? this.redoStack : this.undoStack).push(entry);
    this.persist();
    const after = await readRefState(this.repo);
    const restored = restoreFiles ? ' Uncommitted changes restored.' : '';
    const saved = untrackedSaved ? ' (Untracked files were saved to a snapshot first.)' : '';
    // Files the switch went on past, with their old content still.
    const stale = await staleFiles(this.repo, printed, current.head, { label: title });
    return {
      status: 'done',
      title,
      outcome: `${direction === 'undo' ? 'Undid' : 'Redid'} ${quote(entry.title)}`,
      message:
        `${describeChanges(current, after)}.${restored}${saved}` +
        (stale ? ` ${describeStaleFiles(stale)}` : ''),
      ...(stale ? { errorKind: 'fileInUse', files: stale.map((file) => file.path) } : {}),
      redoable: direction === 'undo' && redoable,
      // Redone, it can be undone again (the toast offers it).
      entry: direction === 'redo' ? entry : undefined,
    };
  }

  /** Puts back the settings of branches `to` has, and deletes those of branches it does not. */
  private async settleBranchSettings(
    settings: NonNullable<JournalEntry['branchSettings']>,
    to: RefState,
    label: string,
  ): Promise<void> {
    for (const [branch, values] of Object.entries(settings)) {
      if (to.refs[`refs/heads/${branch}`]) await restoreBranchSettings(this.repo, branch, values, label);
      else await removeBranchSettings(this.repo, branch, label);
    }
  }

  /**
   * Undoes an operation journaled with its exact effect on the files and the stash list (the
   * stash operations): the index and working tree come back from the snapshot only if they are
   * still exactly as the operation left them, and the stash list change is reversed. These
   * entries are not redone.
   */
  private async undoExact(entry: JournalEntry, title: string): Promise<OperationResult> {
    const files = entry.afterFiles;
    if (files && entry.snapshot) {
      const now = await readWorkState(this.repo);
      if (!sameWorkState(now, files)) {
        return this.refused(
          title,
          `Files changed since ${quote(entry.title)}; Undo would overwrite those changes, so it was not done. Commit or stash them first.`,
          'dirtyWorkTree',
        );
      }
    }
    if (!(await this.waitForLock()))
      return this.refused(
        title,
        'Another git process is using the repository (index.lock exists).',
        'lockFile',
      );
    const done: string[] = [];
    try {
      if (files && entry.snapshot && headMoved(entry.after, entry.before)) {
        // Changes carried to another branch: go back, and they come back exactly as they were.
        await this.switchBackExactly(entry, files, title);
        done.push(`Back on ${entry.before.branch ?? short(entry.before.head)}, files restored`);
      } else if (files && entry.snapshot && diffRefStates(entry.after, entry.before).length > 0) {
        // Changes carried through a cherry-pick or revert: the branch goes back, and they too.
        await this.switchBackExactly(entry, files, title);
        done.push(`files restored, ${describeChanges(entry.after, entry.before)}`);
      } else if (files && entry.snapshot) {
        await restoreExact(this.repo, entry.snapshot, files);
        done.push('Files restored');
      }
      const { created, removed } = entry.stash ?? {};
      if (created) {
        const made = (await readStashList(this.repo)).find((stash) => stash.sha === created);
        if (made) {
          await this.repo.git(['stash', 'drop', '-q', `stash@{${made.index}}`], { label: title });
          done.push('stash removed');
        }
      }
      if (removed && isObjectId(removed.sha)) {
        const list = await readStashList(this.repo);
        if (!list.some((stash) => stash.sha === removed.sha)) {
          await this.repo.git(['stash', 'store', '-m', removed.subject, removed.sha], { label: title });
          done.push('stash back on the list');
        }
      }
    } catch (error) {
      const gitError = error instanceof GitError ? error : undefined;
      return {
        status: 'failed',
        title,
        message: gitError ? describeGitFailure(gitError) : String(error),
        errorKind: gitError?.kind,
        files: gitError?.files,
      };
    }
    this.undoStack.pop();
    this.persist();
    const message = done.join(', ');
    return {
      status: 'done',
      title,
      outcome: `Undid ${quote(entry.title)}`,
      message: message ? `${message[0]!.toUpperCase()}${message.slice(1)}.` : 'Nothing to restore.',
    };
  }

  /**
   * Undoes an operation that carried uncommitted changes (a checkout, a cherry-pick): the files
   * (exactly as it left them, which the caller checked) are snapshotted, cleared, HEAD and the
   * refs go back, and the files come back exactly as they were before. Any failure puts things
   * back as they were.
   */
  private async switchBackExactly(entry: JournalEntry, files: WorkState, title: string): Promise<void> {
    const carried = await takeSnapshot(this.repo, title, this.journalId);
    const message = `lanefold: ${title}`;
    let switched = false;
    try {
      await this.repo.git(['reset', '--hard', '--quiet'], { label: title });
      await moveRefs(this.repo, entry.after, entry.before, message);
      switched = true;
      await restoreExact(this.repo, entry.snapshot!, files);
    } catch (error) {
      if (switched)
        await readRefState(this.repo)
          .then((now) => moveRefs(this.repo, now, entry.after, `lanefold: rollback of ${title}`))
          .catch(() => undefined);
      await this.repo.git(['reset', '--hard', '--quiet'], { label: title }).catch(() => undefined);
      await restoreSnapshot(this.repo, carried).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Rewrites a conflicted file with one side, or with its conflict markers again. The file stays
   * conflicted until it is marked resolved. If it was edited since git stopped, that version is
   * kept next to it as `<file>.orig` (as `git mergetool` does): it may be someone's resolution.
   */
  resolveConflict(path: string, take: 'ours' | 'theirs' | 'markers'): Promise<{ readonly backup?: string }> {
    return this.enqueue(async () => {
      if (take !== 'ours' && take !== 'theirs' && take !== 'markers')
        throw new Error(`Unknown side: ${String(take)}`);
      const state = await readOpState(this.repo);
      if (!state.conflicts.includes(path)) throw new Error(`${path} is not conflicted.`);
      if ((await readSubmoduleConflicts(this.repo, [path])).length > 0)
        throw new Error(
          `${path} is a submodule: it has no text to take or merge. Record one side’s commit for it.`,
        );
      const file = join(this.repo.root, path);
      let backup: string | undefined;
      if (existsSync(file)) {
        const current = await readFile(file);
        const stop = this.stop;
        let untouched = false;
        if (stop?.origin && stop.origin === (await operationOrigin(this.repo, state))) {
          const atStop = await this.repo
            .gitBuffer(['cat-file', 'blob', `${stop.files.worktree}:${path}`], {
              readOnly: true,
              background: true,
              okExitCodes: [0, 128],
            })
            .catch(() => undefined);
          untouched = !!atStop && atStop.exitCode === 0 && Buffer.compare(atStop.stdout, current) === 0;
        }
        if (!untouched) {
          backup = `${path}.orig`;
          for (let n = 2; existsSync(join(this.repo.root, backup)); n++) backup = `${path}.orig${n}`;
          await writeFile(join(this.repo.root, backup), current);
        }
      }
      await this.repo.git(['checkout', take === 'markers' ? '-m' : `--${take}`, ...filePaths(path)], {
        label:
          take === 'markers'
            ? 'Restore conflict markers'
            : `Take the ${take === 'ours' ? 'current' : 'incoming'} side`,
      });
      return { backup };
    });
  }

  /**
   * Resolves a conflict over a submodule by recording one side's commit for it in the index (a
   * gitlink has no contents to merge). Its folder is left as it is: the result says what is
   * checked out there.
   */
  recordSubmoduleConflict(
    path: string,
    side: 'ours' | 'theirs',
  ): Promise<{ readonly recorded: string; readonly checkedOut?: string }> {
    return this.enqueue(async () => {
      if (side !== 'ours' && side !== 'theirs') throw new Error(`Unknown side: ${String(side)}`);
      const [conflict] = await readSubmoduleConflicts(this.repo, [path]);
      if (!conflict) throw new Error(`${path} is not a conflicted submodule.`);
      const commit = side === 'ours' ? conflict.ours : conflict.theirs;
      if (!commit)
        throw new Error(
          `The ${side === 'ours' ? 'current' : 'incoming'} side removed ${path}: record the other side’s commit, or remove it (git rm).`,
        );
      // A stage 0 entry replaces the conflict's stages: the path is resolved.
      await this.repo.git(['update-index', '--cacheinfo', `160000,${commit},${conflict.path}`], {
        label: `Record ${commit.slice(0, 8)} for ${conflict.path}`,
      });
      return { recorded: commit, checkedOut: conflict.checkedOut };
    });
  }

  /** Branches checked out in other worktrees of this repository, with the worktree's folder. */
  private async checkedOutElsewhere(): Promise<Map<string, string>> {
    const worktrees = await readWorktrees(this.repo).catch(() => []);
    return new Map(
      worktrees
        .filter((worktree) => !worktree.current && worktree.branch)
        .map((worktree) => [`refs/heads/${worktree.branch!}`, worktree.path]),
    );
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
    this.plans.clear();
  }
}
