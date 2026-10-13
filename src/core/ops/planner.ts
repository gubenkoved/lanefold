import { randomUUID } from 'node:crypto';
import type { HeadInfo, RefsSnapshot, WorkingTreeSummary, WorktreeChanges } from '../../shared/models';
import type {
  Operation,
  OperationKind,
  OperationPlan,
  OpState,
  PlannedCommand,
  PlanNotice,
  RefChange,
  RefState,
  RewritePreview,
} from '../../shared/operations';
import type { RewriteEntry } from '../../shared/rewrite';
import type { Range, RebaseScript } from '../rebase/rewrite';
import type { SplitStep } from '../rebase/split';
import type { Repository } from '../repo/repository';
import type { StopRecord } from './opState';
import { planBisectMark, planBisectStart } from './plans/bisect';
import {
  planCheckout,
  planCreateBranch,
  planCreateTag,
  planDeleteBranch,
  planDeleteTag,
  planMoveBranch,
  planRenameBranch,
  planReset,
} from './plans/branches';
import {
  planApplyFileChanges,
  planApplyPatch,
  planCommit,
  planDiscard,
  planDiscardLines,
  planRestoreFiles,
  planSetIdentity,
  planStashApply,
  planStashDrop,
  planStashPush,
} from './plans/changes';
import { planControl } from './plans/control';
import { planCherryPick, planMerge, planRebase, planRevert } from './plans/history';
import {
  planAddRemote,
  planRemoveRemote,
  planRenameRemote,
  planSetRemoteUrl,
  withoutCredentials,
} from './plans/remotes';
import { planAmendInto, planRewrite } from './plans/rewrite';
import { planStartSplit } from './plans/split';
import {
  planAddSubmodule,
  planDeinitSubmodules,
  planSyncSubmodules,
  planUpdateSubmodules,
} from './plans/submodules';
import { planDeleteRemoteTag, planFetch, planPull, planPush, planPushTag } from './plans/sync';
import { planAddWorktree, planPruneWorktrees, planRemoveWorktree } from './plans/worktrees';
import { actionLabel } from './verbs';

/** Everything a planner looks at; read once per plan. */
export interface PlanContext {
  readonly repo: Repository;
  readonly state: RefState;
  readonly head: HeadInfo;
  readonly refs: RefsSnapshot;
  readonly opState: OpState;
  readonly workingTree: WorkingTreeSummary;
  /** History editing is possible (Lanefold's sequence editor script is available). */
  readonly canRewrite: boolean;
  /** Lanefold's sequence editor, for plans that change a rebase's todo. */
  readonly rebaseScript?: RebaseScript;
  /** The changed files, read on demand (only some plans need them). */
  readonly worktreeChanges: () => Promise<WorktreeChanges>;
  /** What git left when the operation in progress stopped (if Lanefold ran it). */
  readonly stop?: StopRecord;
  /** The operation Lanefold started that git stopped in (a history edit, a pull…). */
  readonly started?: { readonly kind: OperationKind; readonly title: string };
}

/** What running a history edit needs beyond the commands shown. */
export interface RewriteExecution {
  readonly range: Range;
  /** Normalized entries, oldest first. */
  readonly entries: readonly RewriteEntry[];
  /** `git rebase` arguments. */
  readonly args: readonly string[];
}

/** A plan plus what the executor needs that the webview does not. */
export interface PlanRecord {
  readonly plan: OperationPlan;
  /** Ref state the plan was made against (re-checked before running). */
  readonly expected: RefState;
  /** Take a working-tree snapshot first (the operation can discard uncommitted work). */
  readonly snapshot: boolean;
  /** 'none': no operation may be in progress; otherwise the one it continues/aborts. */
  readonly requiresOpState: 'none' | NonNullable<OpState['kind']>;
  /** History edits run through the planned rebase instead of `plan.commands`. */
  readonly rewrite?: RewriteExecution;
  /** Files Undo restores from the snapshot (instead of the whole working tree). */
  readonly restorePaths?: readonly string[];
  /** Undo restores the snapshot exactly, if the files are still as the operation left them. */
  readonly exactUndo?: boolean;
  /** Stash operations: what they do to the stash list. */
  readonly stash?: StashEffect;
  /**
   * Abort and skip: changes made since git stopped are saved (as a stash) before git discards
   * them. Decided when it runs, from the files as they are then.
   */
  readonly protectWork?: boolean;
  /** Names the commands use, with the commit each named when planned: refused if one moved. */
  readonly pinned?: readonly { readonly rev: string; readonly sha: string }[];
  /** Ignored files the operation overwrites: kept in the snapshot too (git treats them as expendable). */
  readonly snapshotIgnored?: readonly string[];
  /** The commands as git runs them, when `plan.commands` shows them with credentials hidden. */
  readonly commands?: readonly PlannedCommand[];
  /** Splitting a commit at a history edit's stop: this step runs instead of `plan.commands`. */
  readonly split?: SplitStep;
  /** A step inside the stopped operation (a part committed while splitting): journaled with it. */
  readonly duringStop?: boolean;
  /** What commands read on stdin, by index in `plan.commands` (a patch Lanefold built). */
  readonly stdin?: Readonly<Record<number, Buffer>>;
  /** Checked right before running: why the plan no longer fits (refused as stale), or undefined. */
  readonly recheck?: () => Promise<string | undefined>;
  /** What the confirmation says once it ran (instead of how the refs moved). */
  readonly doneMessage?: string;
  /** Environment for the commands, besides the reflog message. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The commands set uncommitted changes aside first (a stash) and bring them back last; when git
   * stops in between, they come back once the stopped operation is done or aborted.
   */
  readonly carries?: boolean;
  /** What the confirmation's headline says once it ran (instead of the title in the past tense). */
  readonly outcome?: string;
}

/** How a stash operation changes the stash list (journaled so Undo can reverse it). */
export interface StashEffect {
  /** It adds a stash. */
  readonly creates?: boolean;
  /** The stash it acts on: still at this position when it runs, or it is refused. */
  readonly target?: { readonly index: number; readonly sha: string; readonly subject: string };
  /** It removes the target from the list (drop, or pop when the changes apply cleanly). */
  readonly removes?: boolean;
}

export class PlanBuilder {
  readonly commands: PlannedCommand[] = [];
  readonly notices: PlanNotice[] = [];
  readonly changes: RefChange[] = [];
  destructive = false;
  blocked = false;
  snapshot = false;
  orphaned: number | undefined;
  conflicts: OperationPlan['conflicts'];
  rewrite: RewriteExecution | undefined;
  rewritePreview: RewritePreview | undefined;
  restorePaths: string[] | undefined;
  exactUndo = false;
  stash: StashEffect | undefined;
  protectWork = false;
  readonly pinned: { rev: string; sha: string }[] = [];
  snapshotIgnored: string[] | undefined;
  carryOver: OperationPlan['carryOver'];
  /** Blocked for want of a remote (the review sheet offers to add one). */
  needsRemote = false;
  split: SplitStep | undefined;
  duringStop = false;
  stdin: Record<number, Buffer> | undefined;
  recheck: PlanRecord['recheck'];
  doneMessage: string | undefined;
  env: Record<string, string> | undefined;
  /** The run button’s label, when the operation’s usual verb is not the best one. */
  action: string | undefined;
  /** What makes the plan destructive, in a few words each (see {@link risk}). */
  readonly risks: string[] = [];
  /** Blocked whatever the form says (see {@link block}). */
  impossible = false;
  /** Blocked by a worktree that has the branch checked out (its folder). */
  worktree: string | undefined;
  carries = false;
  outcome: string | undefined;

  command(
    args: string[],
    explanation: string,
    flags: [string, string][] = [],
    options: { onFailure?: string[]; fallback?: string[] } = {},
  ): void {
    this.commands.push({
      args,
      explanation,
      flags: flags.map(([flag, meaning]) => ({ flag, meaning })),
      ...options,
    });
  }

  notice(level: PlanNotice['level'], text: string): void {
    this.notices.push({ level, text });
  }

  /**
   * Blocks the plan, saying why. `field`: the form input it is about; `missing`: only for want
   * of input (an empty name); `final`: nothing in the form can change it.
   */
  block(text: string, options: { field?: string; missing?: boolean; final?: boolean } = {}): void {
    this.blocked = true;
    if (options.final) this.impossible = true;
    this.notices.push({
      level: 'danger',
      text,
      ...(options.field ? { field: options.field } : {}),
      ...(options.missing ? { missing: true } : {}),
    });
  }

  /** Marks the plan destructive, saying how in a few words (“Discards changes”). */
  risk(label: string): void {
    this.destructive = true;
    if (!this.risks.includes(label)) this.risks.push(label);
  }
}

/** Continue, skip and abort go on with (or stop) what git is in the middle of, as does splitting. */
export const isControl = (operation: Operation) =>
  operation.kind === 'continue' ||
  operation.kind === 'skip' ||
  operation.kind === 'abort' ||
  operation.kind === 'startSplit';

/** Plans an operation: commands, predicted effects and everything worth knowing first. */
export async function planOperation(ctx: PlanContext, operation: Operation): Promise<PlanRecord> {
  const b = new PlanBuilder();
  const control = isControl(operation);
  // Committing the parts of a commit being split is how that history edit goes on.
  const splitPart = operation.kind === 'commit' && !!ctx.opState.split?.opened;
  // Marking commits is how a bisect goes on: it needs one in progress.
  const bisectStep = operation.kind === 'bisectMark';
  // Settings, not history: fine whatever git is in the middle of (a merge cannot be concluded
  // before git knows who you are).
  const settings = operation.kind === 'setIdentity';
  if (!control && !bisectStep && !settings && !splitPart && ctx.opState.kind) {
    b.block(
      ctx.opState.kind === 'bisect'
        ? 'A bisect is in progress. Finish or stop it first.'
        : `A ${ctx.opState.kind} is in progress. Continue or abort it first.`,
      { final: true },
    );
  }
  let title: string;
  switch (operation.kind) {
    case 'checkout':
      title = await planCheckout(ctx, operation, b);
      break;
    case 'createBranch':
      title = await planCreateBranch(ctx, operation, b);
      break;
    case 'deleteBranch':
      title = await planDeleteBranch(ctx, operation, b);
      break;
    case 'renameBranch':
      title = await planRenameBranch(ctx, operation, b);
      break;
    case 'moveBranch':
      title = await planMoveBranch(ctx, operation, b);
      break;
    case 'createTag':
      title = await planCreateTag(ctx, operation, b);
      break;
    case 'deleteTag':
      title = await planDeleteTag(ctx, operation, b);
      break;
    case 'reset':
      title = await planReset(ctx, operation, b);
      break;
    case 'cherryPick':
      title = await planCherryPick(ctx, operation, b);
      break;
    case 'revert':
      title = await planRevert(ctx, operation, b);
      break;
    case 'merge':
      title = await planMerge(ctx, operation, b);
      break;
    case 'rebase':
      title = await planRebase(ctx, operation, b);
      break;
    case 'rewrite':
      title = await planRewrite(ctx, operation, b);
      break;
    case 'amendInto':
      title = await planAmendInto(ctx, operation, b);
      break;
    case 'commit':
      title = await planCommit(ctx, operation, b);
      break;
    case 'setIdentity':
      title = planSetIdentity(operation, b);
      break;
    case 'discard':
      title = await planDiscard(ctx, operation, b);
      break;
    case 'restoreFiles':
      title = await planRestoreFiles(ctx, operation, b);
      break;
    case 'discardLines':
      title = await planDiscardLines(ctx, operation, b);
      break;
    case 'applyPatch':
      title = await planApplyPatch(ctx, operation, b);
      break;
    case 'applyFileChanges':
      title = await planApplyFileChanges(ctx, operation, b);
      break;
    case 'stashPush':
      title = planStashPush(ctx, operation, b);
      break;
    case 'stashApply':
      title = await planStashApply(ctx, operation, b);
      break;
    case 'stashDrop':
      title = await planStashDrop(ctx, operation, b);
      break;
    case 'fetch':
      title = await planFetch(ctx, operation, b);
      break;
    case 'pull':
      title = await planPull(ctx, operation, b);
      break;
    case 'push':
      title = await planPush(ctx, operation, b);
      break;
    case 'pushTag':
      title = await planPushTag(ctx, operation, b);
      break;
    case 'bisectStart':
      title = await planBisectStart(ctx, operation, b);
      break;
    case 'addWorktree':
      title = await planAddWorktree(ctx, operation, b);
      break;
    case 'removeWorktree':
      title = await planRemoveWorktree(ctx, operation, b);
      break;
    case 'pruneWorktrees':
      title = await planPruneWorktrees(ctx, b);
      break;
    case 'updateSubmodules':
      title = await planUpdateSubmodules(ctx, operation, b);
      break;
    case 'addSubmodule':
      title = await planAddSubmodule(ctx, operation, b);
      break;
    case 'syncSubmodules':
      title = await planSyncSubmodules(ctx, operation, b);
      break;
    case 'deinitSubmodules':
      title = await planDeinitSubmodules(ctx, operation, b);
      break;
    case 'bisectMark':
      title = await planBisectMark(ctx, operation, b);
      break;
    case 'deleteRemoteTag':
      title = await planDeleteRemoteTag(ctx, operation, b);
      break;
    case 'addRemote':
      title = await planAddRemote(ctx, operation, b);
      break;
    case 'renameRemote':
      title = await planRenameRemote(ctx, operation, b);
      break;
    case 'removeRemote':
      title = await planRemoveRemote(ctx, operation, b);
      break;
    case 'setRemoteUrl':
      title = await planSetRemoteUrl(ctx, operation, b);
      break;
    case 'continue':
    case 'skip':
    case 'abort':
      title = await planControl(ctx, operation, b);
      break;
    case 'startSplit':
      title = await planStartSplit(ctx, b);
      break;
    default:
      // A webview newer than this backend (or a malformed request): never guess.
      title = 'Unsupported operation';
      b.block(`This version of Lanefold cannot run “${String((operation as { kind?: unknown }).kind)}”.`);
  }
  if (b.conflicts?.predicted) {
    b.notice(
      'warning',
      `Expect conflicts in ${b.conflicts.files.length} file${b.conflicts.files.length === 1 ? '' : 's'}. Git will stop so you can resolve them, or abort.`,
    );
  }
  // Credentials written into URLs stay here: the webview sees them hidden, git gets them as written.
  const shown = withoutCredentials(b.commands);
  const plan: OperationPlan = {
    id: randomUUID(),
    operation,
    title,
    summary: b.commands.map((command) => command.explanation).join(' '),
    commands: shown ?? b.commands,
    notices: b.notices,
    destructive: b.destructive,
    changes: b.changes,
    orphaned: b.orphaned,
    conflicts: b.conflicts,
    blocked: b.blocked || undefined,
    carryOver: b.carryOver,
    rewrite: b.rewritePreview,
    needsRemote: b.needsRemote || undefined,
    action: b.action ?? actionLabel(operation),
    risk: b.destructive ? b.risks.join(' · ') || 'Rewrites or discards' : undefined,
    impossible: (b.blocked && b.impossible) || undefined,
    worktree: b.blocked ? b.worktree : undefined,
  };
  return {
    plan,
    expected: ctx.state,
    snapshot: b.snapshot,
    requiresOpState:
      control || settings || splitPart ? (ctx.opState.kind ?? 'none') : bisectStep ? 'bisect' : 'none',
    rewrite: b.rewrite,
    restorePaths: b.restorePaths,
    exactUndo: b.exactUndo || undefined,
    stash: b.stash,
    protectWork: b.protectWork || undefined,
    pinned: b.pinned.length > 0 ? b.pinned : undefined,
    snapshotIgnored: b.snapshotIgnored,
    commands: shown ? b.commands : undefined,
    split: b.split,
    duringStop: b.duringStop || undefined,
    stdin: b.stdin,
    recheck: b.recheck,
    doneMessage: b.doneMessage,
    env: b.env,
    carries: b.carries || undefined,
    outcome: b.outcome,
  };
}
