import { create } from 'zustand';
import type { Operation, OperationPlan, OperationResult, OpState, UndoInfo } from '../../shared/operations';
import { errorText } from '../bridge/errorText';
import { toast } from '../components/Toast';
import { hostRpc, useApp } from './store';

/** An operation being reviewed in the preview sheet. */
export interface SheetState {
  readonly repoId: string;
  readonly operation: Operation;
  readonly plan?: OperationPlan;
  /** Planning or running. */
  readonly busy: boolean;
  /** Running: the sheet cannot be cancelled now (git is at work). */
  readonly running?: boolean;
  readonly error?: string;
  /** The operation needs input (branch name, mode…) before it can run. */
  readonly form: boolean;
  /** The form was changed since the sheet opened (until then, missing input is no error yet). */
  readonly edited?: boolean;
  /**
   * Run was asked for while the plan was being refreshed (Enter right after typing): it runs as
   * soon as the plan for the latest input is there — unless that one cannot run, or puts more at
   * risk than the plan on screen did (then it is shown to be looked at first).
   */
  readonly queued?: { readonly risk?: string; readonly conflicts: boolean };
  /**
   * How often Run was asked for although the plan could not run: what it lacks reads as an
   * error from then on, not a hint (and the field it is about gets focus).
   */
  readonly attempts?: number;
  /** A queued run was held back: the fresh plan puts more at risk (the sheet says so). */
  readonly held?: boolean;
}

interface OperationsStore {
  readonly sheet?: SheetState;
  readonly undo: UndoInfo;
  readonly opState?: OpState;
  /** The operation being run right now (for progress on the buttons that started it). */
  readonly running?: Operation['kind'];
  /** An operation is being planned or run: buttons that start one wait. */
  readonly starting?: boolean;
}

export const useOperations = create<OperationsStore>(() => ({ undo: {} }));

/** Operations that need input in the sheet before they can run. */
const FORM_KINDS = new Set<Operation['kind']>([
  'createBranch',
  'setIdentity',
  'createTag',
  'renameBranch',
  'reset',
  'merge',
  'stashPush',
  'bisectStart',
  'addWorktree',
  'applyPatch',
  'addRemote',
  'renameRemote',
  'setRemoteUrl',
  'addSubmodule',
]);

/** Repositories with an operation being planned or run from a button (one at a time). */
const inFlight = new Set<string>();

function setInFlight(repoId: string, on: boolean): void {
  if (on) inFlight.add(repoId);
  else inFlight.delete(repoId);
  useOperations.setState({ starting: inFlight.size > 0 });
}

/** Runs `op.execute`, marking the operation as running meanwhile. */
async function execute(repoId: string, planId: string, kind: Operation['kind']) {
  useOperations.setState({ running: kind });
  try {
    return await hostRpc().call('op.execute', { repoId, planId });
  } finally {
    useOperations.setState({ running: undefined });
  }
}

function activeRepo(): string | undefined {
  return useApp.getState().activeRepoId;
}

/** Whether a plan should be reviewed before running, per the `lanefold.confirm` setting. */
function needsReview(plan: OperationPlan): boolean {
  if (plan.blocked) return true;
  const confirm = useApp.getState().settings.confirm;
  if (confirm === 'always') return true;
  if (confirm === 'never') return false;
  return plan.destructive || !!plan.conflicts?.predicted;
}

function describeFailure(result: OperationResult): string | undefined {
  if (result.errorKind === 'dirtyWorkTree' || result.errorKind === 'untrackedOverwritten') {
    const files = result.files?.slice(0, 3).join(', ');
    return `Local changes would be overwritten${files ? `: ${files}` : ''}. Commit or stash them first.`;
  }
  return undefined;
}

/** Operations that can carry uncommitted changes in their way (set aside, then brought back). */
const CARRIES = new Set<Operation['kind']>(['checkout', 'revert', 'cherryPick']);

/** A message that starts by repeating the headline (a sync’s summary) keeps only what follows. */
function beyond(headline: string, message: string): string | undefined {
  if (!message.startsWith(headline)) return message || undefined;
  return message.slice(headline.length).replace(/^[.;:,]?\s*/, '') || undefined;
}

/** Resolves once `repoId` is the active repository (the host selects it first), or false. */
export function whenActive(repoId: string): Promise<boolean> {
  if (activeRepo() === repoId) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, 3000);
    const unsubscribe = useApp.subscribe((state) => {
      if (state.activeRepoId !== repoId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

/** Reports a result: success with Undo, conflicts, or what went wrong. */
export function report(
  result: OperationResult,
  retry?: () => void,
  repoId = activeRepo(),
  operation?: Operation,
): void {
  switch (result.status) {
    case 'done': {
      const entry = result.entry;
      // What was done (“Deleted branch x”), rather than what was asked for.
      const headline = result.outcome ?? result.title;
      // Undoes exactly this operation, in its repository (refused if something else was
      // journaled since).
      const undoIt = entry ? { label: 'Undo', run: () => void undo(entry.id, repoId) } : undefined;
      const stale = result.errorKind === 'fileInUse' ? result.files : undefined;
      if (stale?.length) {
        // Done, but files a program held open still have their old content: once it lets go,
        // they are updated like any change thrown away (Undo works meanwhile too).
        toast(headline, {
          kind: 'error',
          detail: result.message,
          action: {
            label: stale.length === 1 ? 'Update the file…' : 'Update the files…',
            run: () => void runOperation({ kind: 'discard', paths: stale }, { review: true }),
          },
          secondary:
            undoIt ?? (result.redoable ? { label: 'Redo', run: () => void redo(repoId) } : undefined),
          durationMs: 20000,
          group: 'operation',
        });
        break;
      }
      const at = result.detached;
      if (at) {
        // On no branch now: say what that means, and offer the branch that keeps new work.
        toast(headline, {
          kind: 'success',
          detail: 'You’re not on a branch now: new commits won’t belong to one.',
          action: {
            label: 'New branch here…',
            run: () => void runOperation({ kind: 'createBranch', name: '', at, checkout: true }),
          },
          secondary: undoIt,
          durationMs: 10000,
          group: 'operation',
        });
        break;
      }
      toast(headline, {
        kind: 'success',
        detail: beyond(headline, result.message),
        // After an Undo, Redo takes it back; after a Redo, Undo does.
        action: undoIt ?? (result.redoable ? { label: 'Redo', run: () => void redo(repoId) } : undefined),
        durationMs: entry || result.redoable ? 6000 : undefined,
        group: 'operation',
      });
      break;
    }
    case 'conflicts':
    case 'stopped': {
      // Finished with conflicts left to resolve (a carried checkout, an applied stash): it can
      // still be undone as a whole.
      const entry = result.entry;
      toast(result.title, {
        // A step git could not carry out stops the operation too, but it is a failure.
        kind: result.errorKind ? 'error' : 'info',
        detail: result.message,
        action: entry ? { label: 'Undo', run: () => void undo(entry.id, repoId) } : undefined,
        durationMs: 8000,
        group: 'operation',
      });
      break;
    }
    case 'refused':
      toast(`Not done: ${result.title}`, {
        kind: 'error',
        detail: result.message,
        action: result.errorKind === 'stale' && retry ? { label: 'Review again', run: retry } : undefined,
        group: 'operation',
      });
      break;
    case 'failed': {
      const entry = result.entry;
      // A file a program held open: once it is closed, the same again (what git had written
      // is back as it was).
      const retryIt =
        result.errorKind === 'fileInUse' && operation
          ? { label: 'Retry', run: () => void runOperation(operation) }
          : undefined;
      const actions = [
        (result.errorKind === 'dirtyWorkTree' || result.errorKind === 'untrackedOverwritten') &&
        operation &&
        CARRIES.has(operation.kind) &&
        !('carry' in operation && operation.carry)
          ? {
              label: 'Carry my changes over…',
              run: () => void runOperation({ ...operation, carry: true } as Operation, { review: true }),
            }
          : // A new machine: git needs a name and email before it records anything.
            result.errorKind === 'identityUnknown'
            ? {
                label: 'Set name and email…',
                run: () =>
                  void runOperation(
                    { kind: 'setIdentity', name: '', email: '', global: true },
                    { onDone: (done) => done.status === 'done' && retry?.() },
                  ),
              }
            : undefined,
        retryIt,
        // It changed something before failing: that can be taken back.
        entry ? { label: 'Undo', run: () => void undo(entry.id, repoId) } : undefined,
      ].filter((action) => action !== undefined);
      toast(`Failed: ${result.title}`, {
        kind: 'error',
        detail: describeFailure(result) ?? result.message,
        action: actions[0],
        secondary: actions[1],
        durationMs: actions.length > 0 ? 15000 : undefined,
        group: 'operation',
      });
      break;
    }
  }
}

async function plan(repoId: string, operation: Operation): Promise<OperationPlan> {
  return hostRpc().call('op.plan', { repoId, operation });
}

/** Called with the result of the operation the open sheet runs. */
let sheetDone: ((result: OperationResult, operation: Operation) => void) | undefined;

export interface RunOptions {
  /** Always show the review sheet first. */
  readonly review?: boolean;
  /** Called once the operation ran (directly or from the sheet, with what the sheet ran). */
  readonly onDone?: (result: OperationResult, operation: Operation) => void;
}

/**
 * Starts an operation: plans it, shows the preview sheet when it needs input or review, and
 * otherwise runs it right away (with Undo in the confirmation toast).
 */
export async function runOperation(operation: Operation, options: RunOptions = {}): Promise<void> {
  const repoId = activeRepo();
  if (!repoId) return;
  // A second click while the first is still planning or running: that one is already on it.
  if (inFlight.has(repoId) || useOperations.getState().sheet?.running) return;
  const form = FORM_KINDS.has(operation.kind);
  if (form || options.review) {
    openSheet(repoId, operation, form);
    sheetDone = options.onDone;
    return;
  }
  setInFlight(repoId, true);
  let result: OperationResult | undefined;
  try {
    const planned = await plan(repoId, operation);
    if (needsReview(planned)) {
      useOperations.setState({ sheet: { repoId, operation, plan: planned, busy: false, form: false } });
      sheetDone = options.onDone;
      return;
    }
    result = await execute(repoId, planned.id, operation.kind);
    report(result, () => openSheet(repoId, operation, false), repoId, operation);
    void refreshOpState(repoId);
  } catch (error) {
    toast('Could not run the operation', { kind: 'error', detail: errorText(error) });
  } finally {
    setInFlight(repoId, false);
  }
  // After the guard is lifted: what comes next may start another operation (Commit & Push).
  if (result) options.onDone?.(result, operation);
}

let planToken = 0;

/** Opens the sheet and plans (again) for the given operation. */
export function openSheet(repoId: string, operation: Operation, form: boolean): void {
  useOperations.setState((state) => ({
    sheet: {
      repoId,
      operation,
      plan: state.sheet?.operation.kind === operation.kind ? state.sheet.plan : undefined,
      busy: true,
      form,
    },
  }));
  void replan(repoId, operation, form);
}

async function replan(repoId: string, operation: Operation, form: boolean): Promise<void> {
  const token = ++planToken;
  try {
    const planned = await plan(repoId, operation);
    if (token !== planToken) return;
    const before = useOperations.getState().sheet;
    const queued = before?.queued;
    // Run as asked, unless it cannot run or now puts more at risk than what was on screen.
    const riskier =
      !!queued &&
      ((planned.destructive && planned.risk !== queued.risk) ||
        (!!planned.conflicts?.predicted && !queued.conflicts));
    useOperations.setState({
      sheet: {
        repoId,
        operation,
        plan: planned,
        busy: false,
        form,
        edited: before?.edited,
        attempts: (before?.attempts ?? 0) + (queued && planned.blocked ? 1 : 0) || undefined,
        held: riskier || undefined,
      },
    });
    if (queued && !planned.blocked && !riskier) await confirmSheet();
  } catch (error) {
    if (token !== planToken) return;
    // No plan for this input: Run must not run the plan of the previous input.
    useOperations.setState((state) => ({
      sheet: state.sheet && {
        ...state.sheet,
        plan: undefined,
        busy: false,
        queued: undefined,
        error: errorText(error),
      },
    }));
  }
}

let replanTimer: ReturnType<typeof setTimeout> | undefined;

/** Updates the operation being reviewed (form input) and re-plans shortly after. */
export function editSheet(operation: Operation): void {
  const sheet = useOperations.getState().sheet;
  // Not while git runs it: the plan being run is the one on screen.
  if (!sheet || sheet.running) return;
  // A run asked for before this edit was for the input before it: it is dropped.
  useOperations.setState({
    sheet: { ...sheet, operation, busy: true, edited: true, queued: undefined, held: undefined },
  });
  // A plan still on its way is for the input before this edit: it must not bring that back.
  planToken++;
  clearTimeout(replanTimer);
  replanTimer = setTimeout(() => void replan(sheet.repoId, operation, sheet.form), 180);
}

export function closeSheet(): void {
  // While git runs the sheet's operation, the sheet stays (closing would not stop git).
  if (useOperations.getState().sheet?.running) return;
  sheetDone = undefined;
  planToken++;
  clearTimeout(replanTimer);
  useOperations.setState({ sheet: undefined });
}

/**
 * Runs the plan shown in the sheet. While the plan for the latest input is still coming (Enter
 * right after typing), the run waits for it; a plan that cannot run is not run, and what it
 * lacks shows as an error.
 */
export async function confirmSheet(): Promise<void> {
  const sheet = useOperations.getState().sheet;
  if (!sheet || sheet.running) return;
  if (sheet.busy) {
    if (!sheet.queued)
      useOperations.setState({
        sheet: {
          ...sheet,
          queued: { risk: sheet.plan?.risk, conflicts: !!sheet.plan?.conflicts?.predicted },
        },
      });
    return;
  }
  if (!sheet.plan) return;
  if (sheet.plan.blocked) {
    useOperations.setState({ sheet: { ...sheet, attempts: (sheet.attempts ?? 0) + 1 } });
    return;
  }
  useOperations.setState({ sheet: { ...sheet, busy: true, running: true, held: undefined } });
  try {
    const result = await execute(sheet.repoId, sheet.plan.id, sheet.operation.kind);
    if (result.status === 'refused' && result.errorKind === 'stale') {
      // Things moved: show the fresh plan instead of failing.
      toast('The repository changed — here is the updated plan', { kind: 'info' });
      useOperations.setState({ sheet: { ...sheet, plan: undefined, busy: true, running: false } });
      void replan(sheet.repoId, sheet.operation, sheet.form);
      return;
    }
    const done = sheetDone;
    useOperations.setState({ sheet: { ...sheet, running: false } });
    closeSheet();
    report(result, () => openSheet(sheet.repoId, sheet.operation, sheet.form), sheet.repoId, sheet.operation);
    void refreshOpState(sheet.repoId);
    done?.(result, sheet.operation);
  } catch (error) {
    useOperations.setState({ sheet: { ...sheet, busy: false, running: false, error: errorText(error) } });
  }
}

/**
 * Undoes the last operation of a repository (the active one by default); with `entryId`, only
 * if that is still the last one.
 */
export async function undo(entryId?: string, repoId = activeRepo()): Promise<void> {
  if (!repoId) return;
  const result = await hostRpc().call('op.undo', { repoId, entryId });
  report(result, undefined, repoId);
}

/** Redoes what was last undone in a repository (the active one by default). */
export async function redo(repoId = activeRepo()): Promise<void> {
  if (!repoId) return;
  const result = await hostRpc().call('op.redo', { repoId });
  report(result, undefined, repoId);
}

/** Per repository: only the latest answer counts (an older one may describe a moment mid-operation). */
const opStateTokens = new Map<string, number>();

export async function refreshOpState(repoId: string): Promise<void> {
  const token = (opStateTokens.get(repoId) ?? 0) + 1;
  opStateTokens.set(repoId, token);
  try {
    const opState = await hostRpc().call('repo.opState', { repoId });
    if (token === opStateTokens.get(repoId) && repoId === activeRepo()) useOperations.setState({ opState });
  } catch {
    // Repository closed meanwhile.
  }
}

export async function refreshUndo(repoId: string): Promise<void> {
  try {
    const info = await hostRpc().call('op.undoInfo', { repoId });
    if (repoId === activeRepo()) useOperations.setState({ undo: info });
  } catch {
    // Repository closed meanwhile.
  }
}

/** Wires the store to host events (journal changes, repository changes, Undo commands). */
export function connectOperations(): void {
  const rpc = hostRpc();
  rpc.on('op.changed', ({ repoId, undo: info }) => {
    if (repoId === activeRepo()) useOperations.setState({ undo: info });
  });
  rpc.on('repo.changed', ({ repoId, kinds }) => {
    // The banner shows the active repository only.
    if (repoId !== activeRepo()) return;
    // While git is stopped mid-operation, any edit can matter (resolved files, changes to amend).
    const stopped = !!useOperations.getState().opState?.kind;
    if (stopped || kinds.some((kind) => kind === 'opState' || kind === 'index' || kind === 'head'))
      void refreshOpState(repoId);
  });

  // From the command palette (switch branch, fetch, push…): the same flow as a button here.
  rpc.on('command.run', ({ command, args }) => {
    if (command === 'runOperation') {
      const { repoId, operation, review } = (args ?? {}) as {
        repoId?: unknown;
        operation?: { kind?: unknown };
        review?: unknown;
      };
      if (typeof repoId !== 'string' || typeof operation?.kind !== 'string') return;
      void whenActive(repoId).then(
        (active) => active && void runOperation(operation as Operation, { review: review === true }),
      );
    }
  });
  let lastRepo: string | undefined;
  useApp.subscribe((state) => {
    if (state.activeRepoId === lastRepo) return;
    lastRepo = state.activeRepoId;
    useOperations.setState({ undo: {}, opState: undefined });
    if (lastRepo) {
      void refreshUndo(lastRepo);
      void refreshOpState(lastRepo);
    }
  });
}
