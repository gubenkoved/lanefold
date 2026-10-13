import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { viewShowsWorkingTree, type RepoChangeKind, type ViewConfig } from '../../../shared/models';
import type { HostRpc } from '../../bridge/host';
import { LogModel } from '../../graph/logModel';
import { useHost } from '../../hostContext';
import { REFRESH_EVENT } from '../../state/store';

export interface LoadedModel {
  readonly model: LogModel;
  /** Whether the switch to this model should animate (reloads do, first loads don't). */
  readonly animate: boolean;
}

/** How long a reload may take before the new model is shown even if not fully streamed. */
const SWAP_TIMEOUT_MS = 1500;
const CHANGE_DEBOUNCE_MS = 180;

/**
 * Loads one log view and keeps it current. A reload streams into a second model while the
 * current one stays on screen; the switch happens once the new model covers the reading
 * position, so refreshes animate in place instead of flashing.
 */
export class LogLoader {
  private displayed: LogModel | undefined;
  private pending: LogModel | undefined;
  private stopWaiting: (() => void) | undefined;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changedKinds = new Set<RepoChangeKind>();
  private stale = false;
  private disposed = false;
  /** Set once a fast partial load turned out to miss refs: always load everything from then on. */
  private needsComplete = false;
  private stopCompletenessCheck: (() => void) | undefined;
  active = true;

  constructor(
    private readonly rpc: HostRpc,
    private readonly repoId: string,
    private readonly view: ViewConfig,
    private readonly onSwap: (loaded: LoadedModel) => void,
    private readonly topRow: () => number,
    /** Makes the model of each (re)load: by default, this repository's log of the view. */
    private readonly create: () => LogModel = () => new LogModel(rpc, repoId, view),
  ) {}

  /** Starts loading, animating from `previous` (another view's model) when given. */
  start(previous: LogModel | undefined): void {
    this.displayed = previous;
    this.load(previous !== undefined);
  }

  load(animate: boolean): void {
    if (this.disposed) return;
    this.stale = false;
    this.stopWaiting?.();
    this.pending?.dispose();
    const next = this.create();
    this.pending = next;
    void next.open({ complete: this.needsComplete });
    if (!this.displayed) {
      this.swap(next, false);
      return;
    }
    const needed = this.topRow() + 300;
    const covers = () => next.phase === 'ready' || next.phase === 'error' || next.topology.rowCount >= needed;
    const timer = setTimeout(() => this.swap(next, animate), SWAP_TIMEOUT_MS);
    const unsubscribe = next.subscribe(() => {
      if (covers()) this.swap(next, animate);
    });
    this.stopWaiting = () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }

  private swap(next: LogModel, animate: boolean): void {
    if (this.disposed || this.pending !== next) return;
    this.stopWaiting?.();
    this.stopWaiting = undefined;
    this.pending = undefined;
    const previous = this.displayed;
    this.displayed = next;
    this.onSwap({ model: next, animate });
    // The graph captures what it needs from the old model synchronously when it switches.
    if (previous) setTimeout(() => previous.dispose(), 0);
    this.watchCompleteness(next);
  }

  /** After a partial load, reloads everything if some ref's commits did not come with it. */
  private watchCompleteness(model: LogModel): void {
    this.stopCompletenessCheck?.();
    this.stopCompletenessCheck = undefined;
    const check = () => {
      if (model.phase === 'opening' || model.phase === 'streaming') return false;
      this.stopCompletenessCheck?.();
      this.stopCompletenessCheck = undefined;
      if (model === this.displayed && model.missingRefs().length > 0) {
        this.needsComplete = true;
        this.load(true);
      }
      return true;
    };
    if (!check()) this.stopCompletenessCheck = model.subscribe(() => void check());
  }

  onRepoChanged(kinds: readonly RepoChangeKind[]): void {
    for (const kind of kinds) if (kind !== 'config') this.changedKinds.add(kind);
    if (this.changedKinds.size === 0) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.applyChanges(), CHANGE_DEBOUNCE_MS);
  }

  private applyChanges(): void {
    if (this.disposed) return;
    if (!this.active) {
      this.stale = true;
      return;
    }
    const onlyWorkingTree = [...this.changedKinds].every((kind) => kind === 'index' || kind === 'worktree');
    this.changedKinds.clear();
    if (onlyWorkingTree && this.displayed) void this.refreshWorkingTree(this.displayed);
    else this.load(true);
  }

  /** Edits and staging only change the uncommitted-changes row: update it without a reload. */
  private async refreshWorkingTree(model: LogModel): Promise<void> {
    try {
      const summary = await this.rpc.call('repo.workingTree', { repoId: this.repoId });
      if (this.disposed || model !== this.displayed) return;
      const dirty = summary.staged + summary.unstaged + summary.untracked + summary.conflicted > 0;
      // The row comes and goes with the changes (before the first commit too).
      if (viewShowsWorkingTree(this.view) && dirty !== model.hasWorkingTreeRow) this.load(true);
      else model.setWorkingTree(summary);
    } catch {
      this.load(true);
    }
  }

  refresh(): void {
    if (this.active) this.load(true);
    else this.stale = true;
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active && this.stale) this.load(true);
  }

  /** Detaches the displayed model (handed to the next loader) and stops everything else. */
  release(): LogModel | undefined {
    const displayed = this.displayed;
    this.displayed = undefined;
    this.dispose();
    return displayed;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.changeTimer);
    this.stopWaiting?.();
    this.stopCompletenessCheck?.();
    this.pending?.dispose();
    this.displayed?.dispose();
  }
}

/** The model of a log view, reloaded on repository changes and refresh requests. */
export function useLogModel(
  repoId: string,
  view: ViewConfig,
  active: boolean,
  topRow: () => number,
): LoadedModel | undefined {
  const host = useHost();
  const [loaded, setLoaded] = useState<LoadedModel>();
  const loaderRef = useRef<LogLoader | undefined>(undefined);
  const handoverRef = useRef<LogModel | undefined>(undefined);
  const topRowRef = useRef(topRow);
  const activeRef = useRef(active);
  useLayoutEffect(() => {
    topRowRef.current = topRow;
    activeRef.current = active;
  });
  const viewKey = JSON.stringify(view);

  useEffect(() => {
    const loader = new LogLoader(
      host.rpc,
      repoId,
      JSON.parse(viewKey) as ViewConfig,
      (next) => setLoaded(next),
      () => topRowRef.current(),
    );
    loader.active = activeRef.current;
    loaderRef.current = loader;
    const previous = handoverRef.current;
    handoverRef.current = undefined;
    loader.start(previous);

    const offChange = host.rpc.on('repo.changed', ({ repoId: changed, kinds }) => {
      if (changed === repoId) loader.onRepoChanged(kinds);
    });
    const onRefresh = () => loader.refresh();
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => {
      offChange();
      window.removeEventListener(REFRESH_EVENT, onRefresh);
      // Keep the model on screen for the next view (it animates into the new one).
      handoverRef.current = loader.release();
      loaderRef.current = undefined;
    };
  }, [host, repoId, viewKey]);

  useEffect(() => loaderRef.current?.setActive(active), [active]);

  // On unmount nothing takes over the last model.
  useEffect(
    () => () => {
      handoverRef.current?.dispose();
      handoverRef.current = undefined;
    },
    [],
  );

  return loaded;
}
