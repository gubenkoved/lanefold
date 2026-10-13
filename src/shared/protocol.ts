import type { TopologyChunk } from './graph/topology';
import type { DiffArea, FileHunks, LineSelection } from './hunks';
import type {
  ChangedFile,
  CommitDetails,
  CommitMeta,
  CompareSummary,
  ConsoleEntry,
  DiffSide,
  GitInfo,
  HeadInfo,
  ReflogEntry,
  RefsSnapshot,
  RemoteInfo,
  RepoChangeKind,
  RepoSummary,
  SearchQuery,
  SearchResult,
  Settings,
  StashDetails,
  StashEntry,
  SubmoduleInfo,
  ViewConfig,
  WorkingTreeSummary,
  WorktreeChanges,
  WorktreeInfo,
} from './models';
import type { Operation, OperationPlan, OperationResult, OpState, UndoInfo } from './operations';
import type { RewriteEntry, RewriteRange, RewriteSimulation } from './rewrite';
import type { LanguageStats, LineCount, StatsProgress, StatsQuery, StatsResult, StatsScope } from './stats';

export interface LogOpenResult {
  readonly logId: number;
  /** Bytes per object ID (20 SHA-1, 32 SHA-256). */
  readonly oidBytes: number;
  readonly refs: RefsSnapshot;
  readonly workingTree?: WorkingTreeSummary;
  /** True when the view has nothing to show (no chunks will follow, only `log.end`). */
  readonly empty: boolean;
  /**
   * The log starts from recently active refs only (fast first rows). Once loaded, refs whose
   * commits are missing mean the view must be reopened with `complete: true`.
   */
  readonly partial?: boolean;
}

export interface LogEnd {
  readonly logId: number;
  readonly rowCount: number;
  readonly durationMs: number;
  readonly error?: string;
  readonly cancelled?: boolean;
  /** Multi-repository logs: the repositories whose history stopped with an error (by index). */
  readonly sourceErrors?: Readonly<Record<number, string>>;
}

/** One object store in a multi-repository log: a repository, with any open linked worktrees of it. */
export interface ReposLogSource {
  /** The repository its rows belong to (details, diffs and "Show in" use it). */
  readonly repoId: string;
  /** Other open worktrees of that repository: they share its commits and refs. */
  readonly worktrees: readonly string[];
  /** Where their HEADs are (same order as `worktrees`). */
  readonly worktreeHeads: readonly HeadInfo[];
  readonly refs: RefsSnapshot;
  /** Why its history is not in the log. */
  readonly error?: string;
}

export interface ReposLogOpenResult {
  readonly logId: number;
  /** Bytes per object ID (20 SHA-1, 32 SHA-256). */
  readonly oidBytes: number;
  /** Every repository asked for; rows (`TopologyChunk.repos`) index this list. */
  readonly sources: readonly ReposLogSource[];
  /** True when nothing has history to show (no chunks will follow, only `log.end`). */
  readonly empty: boolean;
  /** Some repository's log starts from its recently active refs only (see `LogOpenResult`). */
  readonly partial?: boolean;
}

export interface DiffRequest {
  readonly repoId: string;
  readonly title: string;
  /** Before; omitted for added files. */
  readonly left?: DiffSide;
  /** After; omitted for deleted files. */
  readonly right?: DiffSide;
}

export interface MultiDiffRequest {
  readonly repoId: string;
  readonly title: string;
  readonly files: readonly ChangedFile[];
  /** Revision of the "before" side (undefined: empty tree). */
  readonly base?: string;
  /** Revision of the "after" side, or 'WORKTREE'. */
  readonly target: string;
}

/** Where the webview app is hosted. */
export type HostKind = 'panel' | 'editor' | 'harness';

/** Boot data embedded in the webview HTML (available synchronously at startup). */
export interface Bootstrap {
  readonly host: HostKind;
  /** Webview state restored by VS Code (editor tabs) — opaque to the host. */
  readonly restoredState?: unknown;
}

export interface InitState {
  readonly git?: GitInfo;
  /** Present when git could not be found or is too old. */
  readonly gitError?: string;
  readonly repos: readonly RepoSummary[];
  readonly activeRepoId?: string;
  readonly settings: Settings;
  /** Persisted tabs of the active repository (saves a round trip at startup). */
  readonly tabs?: unknown;
}

/** Host UI actions the webview may request (an allow-list, not arbitrary VS Code commands). */
export type HostCommand =
  'openInEditor' | 'openSettings' | 'showOutput' | 'selectRepository' | 'openFolder' | 'clone' | 'init';

export interface RepoState {
  readonly repoId: string;
  readonly head: HeadInfo;
}

/** Methods the backend (extension host or harness) implements for the webview. */
export interface HostApi {
  'app.init'(): InitState;

  'host.command'(params: { command: HostCommand; args?: unknown }): void;
  'repo.select'(params: { repoId: string }): void;
  'repo.state'(params: { repoId: string }): RepoState;
  'console.history'(): readonly ConsoleEntry[];
  'console.clear'(): void;
  'storage.get'(params: { key: string }): unknown;
  'storage.set'(params: { key: string; value: unknown }): void;

  /** Starts streaming a log view: `log.chunk` events follow, then `log.end`. */
  'log.open'(params: { repoId: string; view: ViewConfig; complete?: boolean }): LogOpenResult;
  'log.close'(params: { logId: number }): void;
  /** Metadata for graph rows (missing commits are omitted). */
  'log.meta'(params: { repoId: string; shas: readonly string[] }): readonly CommitMeta[];
  /** Commits in a view's scope matching a search (newest first, capped at `limit`). */
  'log.search'(params: {
    repoId: string;
    view: ViewConfig;
    query: SearchQuery;
    limit?: number;
  }): SearchResult;
  /**
   * Starts streaming the history of several repositories as one log, newest first by commit
   * date (each repository keeps its own order): `log.chunk` events with each row's repository
   * follow, then `log.end`. Scopes 'all', 'local' and 'head' only.
   */
  'log.openRepos'(params: {
    repoIds: readonly string[];
    view: ViewConfig;
    complete?: boolean;
  }): ReposLogOpenResult;
  'repo.refs'(params: { repoId: string }): RefsSnapshot;
  'repo.workingTree'(params: { repoId: string }): WorkingTreeSummary;
  /** Uncommitted changes as file lists. */
  'repo.worktreeChanges'(params: { repoId: string }): WorktreeChanges;
  'commit.details'(params: { repoId: string; sha: string }): CommitDetails;
  /** The commits as a patch (git format-patch, oldest first), for the clipboard. */
  'patch.text'(params: { repoId: string; shas: readonly string[] }): string;
  /** Saves the commits as a patch file where the person chooses; the path, or null if cancelled. */
  'patch.save'(params: { repoId: string; shas: readonly string[] }): string | null;
  /** Asks the person to choose a file; its path, or null if cancelled. */
  'host.pickFile'(params: { repoId: string; title: string }): string | null;
  /** The repository's working trees (the main one first). */
  'worktree.list'(params: { repoId: string }): readonly WorktreeInfo[];
  /** The repository's remotes, fetched or not (URLs with credentials hidden). */
  'repo.remotes'(params: { repoId: string }): readonly RemoteInfo[];
  /** The repository's submodules (top-level ones, in .gitmodules order). */
  'submodule.list'(params: { repoId: string }): readonly SubmoduleInfo[];
  /**
   * Shows a repository linked to this one in Lanefold: a submodule (by its path) or a worktree
   * (by its folder). It becomes the active repository, registered first if the host had not
   * found it. Anything else is refused.
   */
  'repo.openLinked'(params: { repoId: string; path: string }): { repoId: string };
  /** HEAD's reflog, newest first (at most `limit` entries). */
  'reflog.list'(params: { repoId: string; limit: number }): readonly ReflogEntry[];
  /** The stash list, newest first. */
  'stash.list'(params: { repoId: string }): readonly StashEntry[];
  /** The files a stash holds. */
  'stash.details'(params: { repoId: string; sha: string }): StashDetails;
  /** Files changed from `base` (undefined: the empty tree) to `target`. */
  'diff.files'(params: { repoId: string; base?: string; target: string }): readonly ChangedFile[];
  'compare.summary'(params: {
    repoId: string;
    a: string;
    b: string;
    mode?: 'three-dot' | 'two-dot';
  }): CompareSummary;
  /** Commits reachable from `include` but not `exclude` (newest first). */
  'compare.commits'(params: {
    repoId: string;
    exclude: string;
    include: string;
    limit?: number;
  }): readonly string[];
  /** Opens a native diff editor. */
  'diff.open'(params: DiffRequest): void;
  /** Opens VS Code's multi-file diff editor. */
  'diff.openAll'(params: MultiDiffRequest): void;

  /** Plans an operation (nothing runs): commands, effects, warnings, predicted conflicts. */
  'op.plan'(params: { repoId: string; operation: Operation }): OperationPlan;
  /** Runs a plan after re-checking that the repository is still as planned. */
  'op.execute'(params: { repoId: string; planId: string }): OperationResult;
  /** Undoes the last journaled operation; with `entryId`, only if it is still that one. */
  'op.undo'(params: { repoId: string; entryId?: string }): OperationResult;
  'op.redo'(params: { repoId: string }): OperationResult;
  'op.undoInfo'(params: { repoId: string }): UndoInfo;

  /** The operation git is in the middle of (merge, rebase, …), with its conflicts. */
  'repo.opState'(params: { repoId: string }): OpState;
  /** The commits a history edit after `base` covers (oldest first); undefined without commits. */
  'rewrite.range'(params: { repoId: string; base: string | null }): RewriteRange | undefined;
  /** Dry-runs a history edit with `git merge-tree`: which steps would conflict or become empty. */
  'rewrite.simulate'(params: {
    repoId: string;
    base: string | null;
    entries: readonly RewriteEntry[];
  }): RewriteSimulation;
  /**
   * Rewrites a conflicted file with one side ('ours': HEAD's, 'theirs': incoming); it stays
   * unresolved. `backup`: where the file's edited version was kept (`<file>.orig`), if it had edits.
   */
  'conflict.take'(params: { repoId: string; path: string; side: 'ours' | 'theirs' }): { backup?: string };
  /** Recreates a conflicted file with conflict markers (`git checkout -m`). */
  'conflict.restore'(params: { repoId: string; path: string }): { backup?: string };
  /**
   * Resolves a conflicted submodule by recording one side's commit for it (it has no contents to
   * merge). Says which commit is checked out in it (undefined: none).
   */
  'conflict.recordSubmodule'(params: { repoId: string; path: string; side: 'ours' | 'theirs' }): {
    recorded: string;
    checkedOut?: string;
  };
  /** Stages files (new, modified and deleted ones). */
  'index.stage'(params: { repoId: string; paths: readonly string[] }): void;
  /** Unstages files (their changes stay in the working tree). */
  'index.unstage'(params: { repoId: string; paths: readonly string[] }): void;
  /** One file's unstaged, staged or untracked changes as hunks and lines (for staging parts of them). */
  'diff.hunks'(params: { repoId: string; path: string; area: DiffArea }): FileHunks;
  /**
   * Stages hunks or lines of a file's unstaged (or untracked) diff, named by position in the diff
   * `diff.hunks` returned with `fingerprint`: refused if the file changed since.
   */
  'index.stageLines'(params: {
    repoId: string;
    path: string;
    area: 'unstaged' | 'untracked';
    fingerprint: string;
    selection: LineSelection;
  }): void;
  /** Unstages hunks or lines of a file's staged diff (they stay in the working tree). */
  'index.unstageLines'(params: {
    repoId: string;
    path: string;
    area: 'staged';
    fingerprint: string;
    selection: LineSelection;
  }): void;
  /** Marks conflicted files as resolved (stages them). */
  'conflict.markResolved'(params: { repoId: string; paths: readonly string[] }): void;
  /** Opens a file in an editor: the working-tree file, or (read-only) its content at `rev`. */
  'file.open'(params: { repoId: string; path: string; rev?: string }): void;
  /**
   * Opens a conflicted file in the 3-way merge editor, its sides titled as given (the file with
   * its conflict markers where there is no merge editor, or the conflict is not between two
   * versions: a deletion, say).
   */
  'conflict.mergeEditor'(params: {
    repoId: string;
    path: string;
    current: { title: string; detail?: string };
    incoming: { title: string; detail?: string };
  }): { opened: 'mergeEditor' | 'file' };
  /**
   * Statistics of a scope's commits (reading the commits new since the last call). Lines come
   * from the commits counted so far: `stats.countLines` counts them.
   */
  'stats.get'(params: StatsQuery): StatsResult;
  /**
   * Counts the changed lines of the scope's newest commits not counted yet (`stats.progress`
   * events say how far it is). Resolves when they are all counted; cancelling stops it.
   */
  'stats.countLines'(params: { repoId: string; scope: StatsScope; refresh?: boolean }): LineCount;
  /** HEAD's files by language. */
  'stats.languages'(params: { repoId: string }): LanguageStats;
}

/** Events the backend pushes to the webview. */
export interface HostEvents {
  'repos.changed': { readonly repos: readonly RepoSummary[]; readonly activeRepoId?: string };
  'repo.changed': { readonly repoId: string; readonly kinds: readonly RepoChangeKind[] };
  'console.entry': ConsoleEntry;
  'settings.changed': Settings;
  /** A VS Code command routed into the webview (e.g. refresh, undo). */
  'command.run': { readonly command: string; readonly args?: unknown };
  /** Messages were dropped while the view was hidden; the webview should reload its state. */
  'app.resync': Record<string, never>;
  'log.chunk': TopologyChunk;
  'log.end': LogEnd;
  /** The operation journal changed (labels for Undo/Redo). */
  'op.changed': { readonly repoId: string; readonly undo: UndoInfo };
  /** How far a statistics read is (commits read, lines counted). */
  'stats.progress': StatsProgress;
}

/** A snapshot of the theme VS Code injected into the webview (used to build harness themes). */
export interface ThemeSnapshot {
  readonly bodyClass: string;
  readonly themeKind: string;
  /** All `--vscode-*` custom properties, as `name: value` pairs. */
  readonly variables: Readonly<Record<string, string>>;
}

/** Methods the webview implements for the backend. */
export interface WebviewApi {
  'debug.theme'(): ThemeSnapshot;
}

/** Events the webview sends to the backend. */
export interface WebviewEvents {
  /** The webview script is running and its RPC handlers are registered. */
  'ui.ready': Record<string, never>;
  /**
   * Where focus is: `focused` when the webview has it, `graphFocused` when Lanefold's own
   * shortcuts may act (not while typing, nor in a view with its own undo).
   */
  'ui.focus': { readonly focused: boolean; readonly graphFocused: boolean };
  /** The title for an editor tab: the view it shows. */
  'ui.title': { readonly title: string };
}
