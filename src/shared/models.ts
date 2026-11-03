/** Data shapes shared by the extension host, the dev harness and the webview. */

export interface RepoSummary {
  /** Stable id (the repository root path). */
  readonly id: string;
  readonly root: string;
  /** Folder name, used as the display name. */
  readonly name: string;
  readonly gitDir: string;
  readonly commonDir: string;
}

export interface HeadInfo {
  /** Short branch name when HEAD is attached (e.g. "main"). */
  readonly branch?: string;
  /** Commit HEAD points to; undefined on an unborn branch. */
  readonly sha?: string;
  readonly detached: boolean;
  readonly unborn: boolean;
}

/** Categories of repository change, derived from which files in the git dir changed. */
export type RepoChangeKind = 'head' | 'refs' | 'index' | 'worktree' | 'opState' | 'config' | 'stash';

export type ConfirmLevel = 'always' | 'destructive' | 'never';
export type AnimationLevel = 'full' | 'reduced' | 'off';
export type GraphStyle = 'curved' | 'angular';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type LogOrder = 'date' | 'topo';

export interface Settings {
  readonly confirm: ConfirmLevel;
  readonly animations: AnimationLevel;
  readonly graphStyle: GraphStyle;
  readonly density: Density;
  readonly colors: readonly string[];
  readonly logOrder: LogOrder;
  readonly dateFormat: 'relative' | 'absolute';
  readonly gravatar: boolean;
  readonly defaultTabs: readonly DefaultTabTemplate[];
}

export interface DefaultTabTemplate {
  readonly name: string;
  readonly refs: string;
}

export const DEFAULT_SETTINGS: Settings = {
  confirm: 'destructive',
  animations: 'full',
  graphStyle: 'curved',
  density: 'comfortable',
  colors: [],
  logOrder: 'topo',
  dateFormat: 'relative',
  gravatar: false,
  defaultTabs: [
    { name: 'All', refs: 'all' },
    { name: 'HEAD', refs: 'head' },
  ],
};

/** One git command as shown in the Git Console. */
export interface ConsoleEntry {
  readonly id: number;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly label?: string;
  readonly readOnly: boolean;
  /** A chatty background query (de-emphasized in the console). */
  readonly background?: boolean;
  readonly startedAt: number;
  readonly state: 'running' | 'ok' | 'error' | 'cancelled';
  readonly durationMs?: number;
  readonly exitCode?: number | null;
  readonly stderr?: string;
  readonly stdoutTail?: string;
}

export type RefKind = 'branch' | 'remote' | 'tag';

export interface RefInfo {
  /** Full name, e.g. "refs/heads/main". */
  readonly name: string;
  /** Short name, e.g. "main", "origin/main", "v1.0". */
  readonly short: string;
  readonly kind: RefKind;
  /** Commit the ref points to (peeled for annotated tags). */
  readonly target: string;
  /** Remote name for remote-tracking branches. */
  readonly remote?: string;
  /** Upstream short name (local branches). */
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
  /** The upstream branch no longer exists. */
  readonly gone?: boolean;
  /** Checked out in this worktree. */
  readonly isHead?: boolean;
  /** Annotated tag. */
  readonly annotated?: boolean;
  /** When the ref's commit (or annotated tag) was created, in seconds since the epoch. */
  readonly date?: number;
}

export interface RefsSnapshot {
  readonly refs: readonly RefInfo[];
  readonly head: HeadInfo;
  /** Short name of the branch treated as the trunk (default branch), if any. */
  readonly trunk?: string;
}

/** Commit metadata shown in graph rows (kept small: the graph requests it in pages). */
export interface CommitMeta {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly authorEmail: string;
  /** Seconds since the epoch. */
  readonly authorTime: number;
  readonly committer: string;
  readonly committerEmail: string;
  readonly committerTime: number;
  readonly subject: string;
  readonly signed: boolean;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

export interface ChangedFile {
  readonly path: string;
  /** Source path for renames and copies. */
  readonly oldPath?: string;
  readonly status: FileStatus;
  /** Similarity percentage for renames/copies. */
  readonly score?: number;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  /** The path is a submodule (a gitlink) on either side: which commits it records. */
  readonly submodule?: SubmoduleChange;
}

/** A submodule's change: the commit recorded before and after (a pointer, not file contents). */
export interface SubmoduleChange {
  /** The commit before (undefined: the submodule was added, or was a file). */
  readonly from?: string;
  /**
   * The commit after (undefined: removed, or became a file). In uncommitted changes, the commit
   * checked out in the submodule's folder.
   */
  readonly to?: string;
  /** Uncommitted changes only: files edited inside the submodule (not committed there). */
  readonly modified?: boolean;
  /** Uncommitted changes only: new files inside the submodule. */
  readonly untracked?: boolean;
}

export interface CommitDetails extends CommitMeta {
  readonly body: string;
  /** The parent the file list is relative to (first parent; undefined for root commits). */
  readonly diffBase?: string;
  readonly files: readonly ChangedFile[];
}

export interface CompareSummary {
  readonly a: string;
  readonly b: string;
  readonly mergeBase?: string;
  /** Commits reachable from A but not from B. */
  readonly onlyInA: number;
  /** Commits reachable from B but not from A. */
  readonly onlyInB: number;
  /** Changes on B since the merge base (three-dot) or from A to B directly (two-dot). */
  readonly files: readonly ChangedFile[];
  readonly mode: 'three-dot' | 'two-dot';
}

/** One side of a diff: a file at a revision, the working tree, or nothing (added/deleted). */
export interface DiffSide {
  readonly path: string;
  /** Commit/tree-ish, 'WORKTREE' for the file on disk or 'INDEX' for the staged version. */
  readonly rev: string;
}

/** Uncommitted changes, grouped the way a commit dialog shows them. */
export interface WorktreeChanges {
  /** Index vs HEAD. */
  readonly staged: readonly ChangedFile[];
  /** Working tree vs index (tracked files). */
  readonly unstaged: readonly ChangedFile[];
  readonly untracked: readonly ChangedFile[];
  readonly conflicted: readonly ChangedFile[];
}

/** One entry of the stash list (`stash@{index}`). */
export interface StashEntry {
  readonly index: number;
  readonly sha: string;
  /** The stash's reflog subject: "On main: message", or git's "WIP on main: 1a2b3c4 subject". */
  readonly subject: string;
  /** The message alone (without the "On <branch>:" prefix). */
  readonly message: string;
  /** Git wrote the message (no message was given when stashing). */
  readonly generated: boolean;
  /** The branch it was made on; undefined when HEAD was detached. */
  readonly branch?: string;
  /** The commit it was made on. */
  readonly base: string;
  /** It holds untracked files too. */
  readonly untracked: boolean;
  /** When it was made (seconds since the epoch). */
  readonly time: number;
}

/** A working tree of the repository (`git worktree list`). */
export interface WorktreeInfo {
  readonly path: string;
  readonly head?: string;
  /** The branch checked out there (short name); undefined when detached. */
  readonly branch?: string;
  readonly bare: boolean;
  /** Locked against pruning (with the reason, if one was given). */
  readonly locked?: string;
  /** Its folder is gone: `git worktree prune` would forget it. */
  readonly prunable?: string;
  /** The first worktree (where the repository's .git is). */
  readonly main: boolean;
  /** The worktree this window has open. */
  readonly current: boolean;
}

/**
 * A remote of the repository (`git remote`), whether or not it was ever fetched. Credentials
 * written into its URLs never leave the host: they show as `***`.
 */
export interface RemoteInfo {
  readonly name: string;
  /** Where it fetches from (and pushes to, without `pushUrl`); undefined when none is set. */
  readonly url?: string;
  /** Where pushes go, when that is not `url`. */
  readonly pushUrl?: string;
  /** A password or token in one of its URLs was hidden. */
  readonly credentialsHidden?: boolean;
}

/**
 * Where a submodule stands: `uninitialized` (not set up here: nothing cloned or checked out),
 * `missing` (set up, but not checked out: its folder was deleted, or cloning it failed),
 * `upToDate` (at the recorded commit), `otherCommit` (another commit is checked out), `dirty`
 * (uncommitted changes inside it), `conflicted` (a merge left two commits for it).
 */
export type SubmoduleState =
  'uninitialized' | 'missing' | 'upToDate' | 'otherCommit' | 'dirty' | 'conflicted';

/** A submodule of the repository: what .gitmodules says, the commits recorded for it, its checkout. */
export interface SubmoduleInfo {
  /** Its name in .gitmodules (often its path). */
  readonly name: string;
  /** Its folder, relative to the repository root (forward slashes). */
  readonly path: string;
  /**
   * Where it is cloned from: the URL in .gitmodules, a relative one resolved the way git does
   * (passwords and tokens hidden).
   */
  readonly url?: string;
  /**
   * Only when it differs from `url`: the URL this repository's settings have for it, which
   * fetches use until it is synced (.gitmodules changed it since it was initialized).
   */
  readonly settingsUrl?: string;
  /** The branch it follows (`branch` in .gitmodules), if one is set. */
  readonly branch?: string;
  /** The commit HEAD records (undefined: added but not committed yet, or conflicted). */
  readonly head?: string;
  /** The commit the index records: what `git submodule update` checks out (undefined: conflicted). */
  readonly recorded?: string;
  /** The commit checked out in its folder (undefined: not checked out). */
  readonly checkedOut?: string;
  /** The most important of its states (see {@link SubmoduleState}). */
  readonly state: SubmoduleState;
  /** Files edited inside it, not committed there (also when it is at another commit). */
  readonly modified: boolean;
  /** New files inside it. */
  readonly untracked: boolean;
  /** It has submodules of its own. */
  readonly nested: boolean;
}

/** One entry of HEAD's reflog: where HEAD pointed, and what moved it there. */
export interface ReflogEntry {
  /** 0 is the newest (HEAD@{0}). */
  readonly index: number;
  readonly sha: string;
  /** What git recorded: "commit", "checkout", "reset", "rebase (finish)", "lanefold: …". */
  readonly action: string;
  /** The rest of the entry ("moving from main to feature", the commit subject…). */
  readonly detail: string;
  /** When HEAD moved (seconds since the epoch). */
  readonly time: number;
  /** The commit's subject. */
  readonly subject: string;
  /** No branch, tag or remote branch contains the commit any more (only the reflog keeps it). */
  readonly lost: boolean;
}

/** What a stash holds. Diffs: `base` → `sha` (tracked files), empty → `untrackedCommit`. */
export interface StashDetails {
  readonly sha: string;
  readonly base: string;
  /** Changes to tracked files, as they were in the working tree. */
  readonly files: readonly ChangedFile[];
  /** The part of those changes that was staged. */
  readonly staged: readonly ChangedFile[];
  /** Untracked files it saved (stashed with --include-untracked). */
  readonly untracked: readonly ChangedFile[];
  readonly indexCommit: string;
  readonly untrackedCommit?: string;
}

export interface WorkingTreeSummary {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly conflicted: number;
}

/** Which refs a log view starts from. */
export type RefScope =
  | { readonly type: 'all' }
  | { readonly type: 'head' }
  | { readonly type: 'local' }
  | { readonly type: 'refs'; readonly refs: readonly string[] };

/** A saved log view — what a log tab shows. */
export interface ViewConfig {
  readonly scope: RefScope;
  readonly order?: LogOrder;
  readonly firstParent?: boolean;
  readonly noMerges?: boolean;
  /** Limit history to commits touching these paths (git keeps the graph connected). */
  readonly paths?: readonly string[];
  /**
   * Refs (full names) left out of an 'all' or 'local' view: their pills, and commits only they
   * reach.
   */
  readonly hidden?: readonly string[];
  /**
   * Refs (full names) shown besides a 'head' or 'local' view's own: the current branch and
   * `main`, say, or the local branches and a remote branch.
   */
  readonly extra?: readonly string[];
  /** Line history: the commits that changed these lines of a file, followed back through edits (`git log -L`). */
  readonly lines?: LineRange;
}

/** Lines `start`–`end` (1-based, inclusive) of a file. */
export interface LineRange {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export function isLineRange(value: unknown): value is LineRange {
  if (!value || typeof value !== 'object') return false;
  const { path, start, end } = value as Partial<LineRange>;
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !/[\0\n]/.test(path) &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start! >= 1 &&
    end! >= start!
  );
}

/** The uncommitted-changes row belongs in views of the whole working tree only. */
export function viewShowsWorkingTree(view: ViewConfig): boolean {
  return view.scope.type !== 'refs' && !view.paths?.length && !view.lines;
}

/** A ref name that can be hidden from a view: a branch, remote branch or tag, no patterns. */
export function isHideableRef(name: string): boolean {
  return /^refs\/(?:heads|remotes|tags)\/[^*?[\\\s]+$/.test(name) && !name.includes('..');
}

/** Parsed search box query. Plain text matches messages and authors; operators narrow it. */
export interface SearchQuery {
  readonly text?: string;
  readonly author?: string;
  readonly message?: string;
  readonly paths?: readonly string[];
  /** Dates in any format git understands ("2024-01-01", "2 weeks ago"). */
  readonly after?: string;
  readonly before?: string;
}

export interface SearchResult {
  readonly shas: readonly string[];
  /** More matches exist than were returned. */
  readonly truncated: boolean;
}

/** Parses "fix @alice file:src/ after:2024-01-01 message:login #abc" into a query. */
export function parseSearch(input: string): SearchQuery & { readonly hash?: string } {
  const words: string[] = [];
  let author: string | undefined;
  let message: string | undefined;
  let hash: string | undefined;
  let after: string | undefined;
  let before: string | undefined;
  const paths: string[] = [];
  // Tokens may be quoted: author:"Jane Doe".
  for (const match of input.matchAll(/(\S+?:)?("([^"]*)"|\S+)/g)) {
    const key = match[1]?.slice(0, -1).toLowerCase();
    // The key is its own group: a value keeps any colons of its own (file:a:b, after:…T10:00).
    const value = match[3] ?? match[2]!;
    const raw = match[0];
    if (key === 'author' || key === 'a') author = value;
    else if (key === 'message' || key === 'm' || key === 'msg') message = value;
    else if (key === 'file' || key === 'path' || key === 'f') paths.push(value);
    else if (key === 'after' || key === 'since') after = value;
    else if (key === 'before' || key === 'until') before = value;
    else if (key === 'commit' || key === 'sha' || key === 'hash') hash = value.toLowerCase();
    else if (raw.startsWith('@') && raw.length > 1) author = raw.slice(1);
    else if (raw.startsWith('#') && /^#[0-9a-f]{4,64}$/i.test(raw)) hash = raw.slice(1).toLowerCase();
    else words.push(match[3] ?? raw);
  }
  const text = words.join(' ').trim();
  return {
    text: text || undefined,
    author,
    message,
    hash,
    paths: paths.length > 0 ? paths : undefined,
    after,
    before,
  };
}

/** Parses the `refs` string of a default-tab template ('all', 'head', 'local' or ref names/globs). */
export function parseRefScope(refs: string): RefScope {
  const trimmed = refs.trim();
  if (trimmed === 'all' || trimmed === '') return { type: 'all' };
  if (trimmed === 'head' || trimmed === 'HEAD') return { type: 'head' };
  if (trimmed === 'local') return { type: 'local' };
  return { type: 'refs', refs: trimmed.split(/\s+/) };
}

export interface GitInfo {
  readonly path: string;
  readonly version: string;
  readonly supported: boolean;
}
