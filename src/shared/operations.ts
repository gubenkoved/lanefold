/**
 * Repository-changing operations: what the webview can ask for, how a plan describes it before
 * anything runs, and what the journal records so every operation can be undone.
 */

import type { LineSelection } from './hunks';
import type { RewriteEntry } from './rewrite';

export type ResetMode = 'soft' | 'mixed' | 'keep' | 'hard';
export type MergeStrategy = 'auto' | 'no-ff' | 'ff-only' | 'squash';
/** How a pull combines local and incoming commits. */
export type PullMode = 'ff-only' | 'rebase' | 'merge';

export type Operation =
  /** Switch to a local branch, a remote branch (creating a tracking branch) or a commit. */
  | {
      readonly kind: 'checkout';
      readonly target: string;
      readonly detach?: boolean;
      readonly trackAs?: string;
      /**
       * Carry uncommitted changes that are in the way over to the target ("smart checkout"):
       * they are stashed, the switch is made, and they are restored there.
       */
      readonly carry?: boolean;
    }
  | { readonly kind: 'createBranch'; readonly name: string; readonly at: string; readonly checkout?: boolean }
  /** Tell git who you are (user.name, user.email): for every repository, or just this one. */
  | { readonly kind: 'setIdentity'; readonly name: string; readonly email: string; readonly global: boolean }
  | {
      readonly kind: 'deleteBranch';
      readonly name: string;
      readonly force?: boolean;
      /** Also delete its upstream from the remote (`git push --delete`), which Undo cannot bring back. */
      readonly remote?: boolean;
    }
  /**
   * Delete several local branches at once (those whose upstream is gone, say). The one checked
   * out, and those checked out in other worktrees, stay. Undo brings them all back.
   */
  | { readonly kind: 'deleteBranches'; readonly names: readonly string[] }
  /**
   * Delete a branch from its remote (`git push --delete`), named by its remote branch here
   * (“origin/feature”), which goes too: only if it is still where it was last fetched.
   */
  | { readonly kind: 'deleteRemoteBranch'; readonly name: string }
  /**
   * Make a local branch track a remote branch (“origin/feature”): pull and push go there. Without
   * `upstream`, it stops tracking the one it has.
   */
  | { readonly kind: 'setUpstream'; readonly branch: string; readonly upstream?: string }
  | {
      readonly kind: 'renameBranch';
      readonly from: string;
      readonly to: string;
      /**
       * Also rename its upstream on the remote: push it there under the new name (tracking that),
       * then delete the old name there. Undo cannot take that part back.
       */
      readonly remote?: boolean;
    }
  /** Point a branch that is not checked out at another commit (`git branch --force`). */
  | { readonly kind: 'moveBranch'; readonly name: string; readonly to: string }
  | { readonly kind: 'createTag'; readonly name: string; readonly at: string; readonly message?: string }
  | { readonly kind: 'deleteTag'; readonly name: string }
  /** Move the current branch (or detached HEAD) to a commit. */
  | { readonly kind: 'reset'; readonly to: string; readonly mode: ResetMode }
  /**
   * Add commits that undo these. `carry`: uncommitted changes in the way are set aside first and
   * brought back after (as a checkout carries them).
   */
  | { readonly kind: 'revert'; readonly commits: readonly string[]; readonly carry?: boolean }
  | {
      readonly kind: 'cherryPick';
      readonly commits: readonly string[];
      readonly recordOrigin?: boolean;
      /** Uncommitted changes in the way are set aside first and brought back after. */
      readonly carry?: boolean;
    }
  | {
      readonly kind: 'merge';
      readonly source: string;
      readonly strategy: MergeStrategy;
      readonly message?: string;
    }
  /** Replay the current branch onto another commit. */
  | { readonly kind: 'rebase'; readonly onto: string }
  /**
   * Edit the history of the current branch after `base` (interactive rebase): reorder, squash,
   * fix up, reword, stop to edit, or drop commits. `entries` lists every commit of base..HEAD
   * exactly once, oldest first, in the order they are to be applied.
   */
  | {
      readonly kind: 'rewrite';
      /** The commit the edited history starts after; `null` edits from the root commit. */
      readonly base: string | null;
      readonly entries: readonly RewriteEntry[];
      /** Also move other local branches that point into the edited history (`--update-refs`). */
      readonly updateRefs?: boolean;
    }
  /**
   * Put the staged changes into a commit of the current branch's recent history (after its
   * last merge), keeping that commit's message: a “fixup!” commit folded in by
   * `git rebase --autosquash`. Undo brings the changes back as staged.
   */
  | { readonly kind: 'amendInto'; readonly commit: string }
  /** Record the staged changes as a new commit (or amend the last one). */
  | {
      readonly kind: 'commit';
      readonly message: string;
      readonly amend?: boolean;
      /** Add a "Signed-off-by" trailer. */
      readonly signoff?: boolean;
    }
  /**
   * Set uncommitted changes aside on the stash list; the working tree goes back to HEAD (or to
   * what is staged, with `keepIndex`).
   */
  | {
      readonly kind: 'stashPush';
      readonly message?: string;
      /** Untracked files too (--include-untracked). */
      readonly includeUntracked?: boolean;
      /** Leave the staged changes in place (--keep-index). */
      readonly keepIndex?: boolean;
      /** Only the staged changes (--staged). */
      readonly stagedOnly?: boolean;
      /** Only these files. */
      readonly paths?: readonly string[];
    }
  /**
   * Bring a stash's changes back (`stash` is its commit). `pop` also removes it from the list
   * when it applies cleanly; `index` restores which changes were staged.
   */
  | { readonly kind: 'stashApply'; readonly stash: string; readonly pop?: boolean; readonly index?: boolean }
  /** Remove a stash from the list (Undo puts it back). */
  | { readonly kind: 'stashDrop'; readonly stash: string }
  /**
   * Throw away uncommitted changes to files (unstaged edits; untracked files are deleted). A
   * snapshot is taken first, so Undo brings them back.
   */
  | { readonly kind: 'discard'; readonly paths: readonly string[] }
  /** Put files back as they were in a commit (working tree only; Undo brings the current ones back). */
  | { readonly kind: 'restoreFiles'; readonly source: string; readonly paths: readonly string[] }
  /**
   * Copy one commit's changes to some files into the working tree and index — or, with
   * `reverse`, take them back out (`git diff <commit>^ <commit> -- <paths> | git apply --3way`).
   */
  | {
      readonly kind: 'applyFileChanges';
      readonly commit: string;
      readonly paths: readonly string[];
      readonly reverse?: boolean;
    }
  /**
   * Apply a patch file: its changes to the working tree and index (`git apply --3way`), or, with
   * `commit`, the commits it holds onto the current branch (`git am --3way`).
   */
  | { readonly kind: 'applyPatch'; readonly file: string; readonly commit?: boolean }
  /**
   * Throw away some unstaged changes of a file: hunks or lines of the diff `diff.hunks` showed
   * with `fingerprint` (refused if the file changed since). A snapshot is taken first, so Undo
   * brings them back.
   */
  | {
      readonly kind: 'discardLines';
      readonly path: string;
      readonly fingerprint: string;
      readonly selection: LineSelection;
    }
  /** Download from a remote (or all remotes); local branches do not move. */
  | { readonly kind: 'fetch'; readonly remote?: string; readonly prune?: boolean }
  /** Bring the current branch up to date with its upstream. */
  | { readonly kind: 'pull'; readonly mode: PullMode }
  /**
   * Publish a branch (default: the current one) to a remote. `force` replaces what the remote
   * has, but only if it is still what the plan showed (--force-with-lease with that commit).
   */
  | {
      readonly kind: 'push';
      readonly branch?: string;
      readonly remote?: string;
      readonly setUpstream?: boolean;
      readonly force?: boolean;
      /** Also push annotated tags that point at the pushed commits (--follow-tags). */
      readonly tags?: boolean;
    }
  /** Start finding the commit that introduced a bug: `bad` has it, the `good` commits do not. */
  | { readonly kind: 'bisectStart'; readonly bad: string; readonly good: readonly string[] }
  /** Tell bisect how a commit (default: the one checked out) behaves. */
  | { readonly kind: 'bisectMark'; readonly verdict: 'good' | 'bad' | 'skip'; readonly commit?: string }
  /**
   * Check a branch out in a new working tree (a separate folder sharing this repository):
   * an existing `branch`, or a `newBranch` created at `at`.
   */
  | {
      readonly kind: 'addWorktree';
      readonly path: string;
      readonly branch?: string;
      readonly newBranch?: string;
      readonly at?: string;
    }
  /** Delete a working tree's folder (git refuses while it has uncommitted changes). */
  | { readonly kind: 'removeWorktree'; readonly path: string }
  /** Forget working trees whose folders are gone. */
  | { readonly kind: 'pruneWorktrees' }
  /**
   * Check out, in submodules (these `paths`, or all), the commits this repository records for
   * them; `init` also clones those not initialized yet, `recursive` their own submodules too.
   */
  | {
      readonly kind: 'updateSubmodules';
      readonly paths?: readonly string[];
      readonly init?: boolean;
      readonly recursive?: boolean;
    }
  /** Clone a repository into a folder of this one and record it as a submodule (staged). */
  | { readonly kind: 'addSubmodule'; readonly url: string; readonly path: string; readonly branch?: string }
  /** Copy submodule URLs from .gitmodules into the settings (after .gitmodules changed them). */
  | { readonly kind: 'syncSubmodules'; readonly paths?: readonly string[] }
  /** Remove submodules' checkouts; they stay recorded here, uninitialized. */
  | { readonly kind: 'deinitSubmodules'; readonly paths: readonly string[] }
  /** Publish a tag (or, without `name`, every local tag) to a remote. */
  | { readonly kind: 'pushTag'; readonly name?: string; readonly remote?: string }
  /** Delete a tag from a remote (the local tag stays). */
  | { readonly kind: 'deleteRemoteTag'; readonly name: string; readonly remote?: string }
  /** Continue, skip or abort the operation in progress (merge, rebase, cherry-pick, revert). */
  | {
      readonly kind: 'continue';
      /** For a merge: the message of the merge commit, instead of the one git prepared. */
      readonly message?: string;
    }
  | { readonly kind: 'skip' }
  | { readonly kind: 'abort' }
  /** Add a remote (`git remote add`); with `fetch`, download its branches right away. */
  | { readonly kind: 'addRemote'; readonly name: string; readonly url: string; readonly fetch?: boolean }
  /** Rename a remote: its remote branches and the upstreams of branches tracking it follow. */
  | { readonly kind: 'renameRemote'; readonly from: string; readonly to: string }
  /** Remove a remote and its remote branches; branches tracking it lose their upstream. */
  | { readonly kind: 'removeRemote'; readonly name: string }
  /** Point a remote at another URL; with `push`, only where its pushes go. */
  | { readonly kind: 'setRemoteUrl'; readonly name: string; readonly url: string; readonly push?: boolean }
  /**
   * At a history edit's stop on a commit to split, when it is still whole (git got there outside
   * Lanefold, or stopped on a conflict first): put its changes back in the working tree,
   * uncommitted, to be committed in parts.
   */
  | { readonly kind: 'startSplit' };

export type OperationKind = Operation['kind'];

/** One git invocation of a plan, with what its flags mean. */
export interface PlannedCommand {
  readonly args: readonly string[];
  /** Reads the previous command's output (`git diff … | git apply …`). */
  readonly pipe?: boolean;
  /** Runs if this command fails, to put back what the steps before it set aside. */
  readonly onFailure?: readonly string[];
  /** Runs instead if this command fails without leaving conflicts; the operation goes on. */
  readonly fallback?: readonly string[];
  /** Plain-language explanation of what this command does. */
  readonly explanation: string;
  /** Explanations of the notable flags, in order. */
  readonly flags: readonly { readonly flag: string; readonly meaning: string }[];
}

export type NoticeLevel = 'info' | 'warning' | 'danger';

export interface PlanNotice {
  readonly level: NoticeLevel;
  readonly text: string;
  /** The form field it is about (“name”, “url”…): the sheet shows it there and marks the field. */
  readonly field?: string;
  /** Blocked only for want of input: on a form not filled in yet, it reads as a hint. */
  readonly missing?: boolean;
}

/** A predicted ref move ("main: a1b2c3 → d4e5f6"). `undefined` means absent (created/deleted). */
export interface RefChange {
  readonly ref: string;
  readonly from?: string;
  readonly to?: string;
  /** The ref moves to commits the operation creates ("merge commit", "2 new commits"). */
  readonly toNew?: string;
}

export interface OperationPlan {
  readonly id: string;
  readonly operation: Operation;
  /** "Merge feature/login into main". */
  readonly title: string;
  /** One or two sentences on what will happen. */
  readonly summary: string;
  readonly commands: readonly PlannedCommand[];
  readonly notices: readonly PlanNotice[];
  /** Can lose work or rewrite history (always confirmed, unless confirmations are off). */
  readonly destructive: boolean;
  /** Refs the plan expects to move. */
  readonly changes: readonly RefChange[];
  /** Commits that will no longer be on any branch or tag (still recoverable with Undo). */
  readonly orphaned?: number;
  /** Conflicts git will stop on, predicted without touching the working tree. */
  readonly conflicts?: { readonly predicted: boolean; readonly files: readonly string[] };
  /** The plan cannot run as is (the reason is in a 'danger' notice). */
  readonly blocked?: boolean;
  /** A checkout that uncommitted changes to these files are in the way of (they can be carried). */
  readonly carryOver?: { readonly files: readonly string[] };
  /** History editing: what git will be told to do, and what comes out. */
  readonly rewrite?: RewritePreview;
  /** Blocked because the repository has no remote: adding one is the way on. */
  readonly needsRemote?: boolean;
  /** What the button that runs it says (“Delete branch”, “Force push”). */
  readonly action?: string;
  /** What makes it destructive, in a few words (“Discards changes”): the sheet’s badge. */
  readonly risk?: string;
  /** Blocked whatever the form says (the branch already has the commit): its fields do nothing. */
  readonly impossible?: boolean;
  /** Blocked because the branch is checked out in this worktree: opening it there is the way on. */
  readonly worktree?: string;
  /**
   * A branch deletion or rename: the branch’s upstream (“origin/feature”), which it can delete
   * from the remote, or rename there, too.
   */
  readonly remoteBranch?: string;
  /** A rename: the remote of {@link remoteBranch} (“origin”). */
  readonly upstreamRemote?: string;
}

export interface RewritePreview {
  /** The rebase todo git follows; `<message: …>` stands for the commits carrying new messages. */
  readonly todo: string;
  /** Number of commits before and after. */
  readonly before: number;
  readonly after: number;
  /** Commits that get new hashes (from the first change on). */
  readonly rewritten: number;
  /** Other branches and tags that point into the rewritten commits (short names). */
  readonly strandedRefs: readonly string[];
  /** Branches `--update-refs` will move along (short names). */
  readonly updatedRefs: readonly string[];
  /** Commits split at a stop: each becomes one or more commits, so `after` is a minimum. */
  readonly splits?: number;
}

/** HEAD and refs at one moment (what Undo restores). */
export interface RefState {
  /** Branch HEAD is on (short name), or undefined when detached/unborn. */
  readonly branch?: string;
  readonly head?: string;
  /** Full ref name → object ID, for local branches, tags and the stash. */
  readonly refs: Readonly<Record<string, string>>;
}

/** The index and working tree, fingerprinted to tell whether anything changed. */
export interface WorkState {
  /** Hash of `git ls-files --stage` (paths, modes, contents and conflict stages). */
  readonly index: string;
  /** The working tree as a tree object, untracked (not ignored) files included. */
  readonly worktree: string;
}

/** What an operation did to the stash list. */
export interface StashChange {
  /** The stash it made (Undo removes it again). */
  readonly created?: string;
  /** A stash it removed, with its reflog subject (Undo puts it back on the list). */
  readonly removed?: { readonly sha: string; readonly subject: string };
}

export interface JournalEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: OperationKind | 'undo' | 'redo';
  readonly time: number;
  readonly before: RefState;
  readonly after: RefState;
  /** Commit holding the working tree and index from before a destructive operation. */
  readonly snapshot?: string;
  /** Only these files are restored from the snapshot on Undo (a discard of some files). */
  readonly paths?: readonly string[];
  /** Content hashes of those files as the operation left them (`null`: absent); Undo checks them. */
  readonly pathsAfter?: Readonly<Record<string, string | null>>;
  /** Stash list changes (Undo reverses them). */
  readonly stash?: StashChange;
  /** The index and working tree as the operation left them: Undo restores the snapshot only if they still are. */
  readonly afterFiles?: WorkState;
  /**
   * The settings of branches it deleted (`branch.<name>.<key>`: their upstream, mostly), which git
   * deletes with them: Undo puts them back with the branches.
   */
  readonly branchSettings?: Readonly<Record<string, readonly (readonly [string, string])[]>>;
}

export type OperationStatus = 'done' | 'conflicts' | 'stopped' | 'failed' | 'refused';

export interface OperationResult {
  readonly status: OperationStatus;
  readonly title: string;
  /** What happened, for the toast ("main moved to 1a2b3c4"). */
  readonly message: string;
  /** The journal entry (present when something changed and can be undone). */
  readonly entry?: JournalEntry;
  readonly conflicts?: readonly string[];
  /** Typed git error kind (e.g. 'dirtyWorkTree') and the files involved. */
  readonly errorKind?: string;
  readonly files?: readonly string[];
  /** History editing: old commit → the commit it became (squashed commits map to their group's). */
  readonly rewritten?: Readonly<Record<string, string>>;
  /** What was done, for the toast of a finished operation (“Deleted branch x”); `title` names it. */
  readonly outcome?: string;
  /** It left HEAD detached at this commit (on no branch): worth explaining, and a branch there. */
  readonly detached?: string;
  /** An Undo that Redo can take back (the toast offers it). */
  readonly redoable?: boolean;
}

export type OperationInProgress = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | 'am';

/** An operation git stopped in the middle of (conflicts or an edit stop). */
export interface OpState {
  readonly kind?: OperationInProgress;
  /** Rebase progress (1-based step) and total. */
  readonly step?: number;
  readonly total?: number;
  /** The commit being applied (cherry-pick, revert, rebase) or merged in. */
  readonly commit?: string;
  readonly commitSubject?: string;
  /** Branch being rebased / merged into, and what onto / from. */
  readonly branch?: string;
  readonly onto?: string;
  /** A branch or tag at `commit` (what is merged or picked), to name the incoming side by. */
  readonly incomingRef?: string;
  /** A branch or tag at `onto` (what a rebase replays onto), to name that side by. */
  readonly ontoRef?: string;
  /** The message git prepared for the commit that concludes the step (merge, pick, revert). */
  readonly message?: string;
  /** A rebase's original commits: those replayed already and those still to come (in order). */
  readonly steps?: { readonly done: readonly string[]; readonly todo: readonly string[] };
  readonly conflicts: readonly string[];
  /** Git stopped so the commit can be amended (rebase `edit`), not because of a conflict. */
  readonly editStop?: boolean;
  /**
   * A rebase step git could not carry out, for a reason other than a conflict (a file it could
   * not write, say). The step is still to do, and what it wrote before failing is in the working
   * tree. `reason` is git's account in plain words, when Lanefold ran the step.
   */
  readonly failedStep?: { readonly commit: string; readonly subject?: string; readonly reason?: string };
  /** The rebase was started by Lanefold's history editor. */
  readonly historyEdit?: boolean;
  /** Lanefold is running this operation right now (git's state files are mid-flight). */
  readonly running?: string;
  /** The operation Lanefold started that stopped here (a pull, an amend…): it names the stop. */
  readonly started?: { readonly kind: OperationKind; readonly title: string };
  /** At an edit stop: uncommitted changes (Continue amends staged ones into the commit). */
  readonly changes?: { readonly staged: number; readonly unstaged: number; readonly untracked: number };
  /** A history edit stopped at a commit it splits. */
  readonly split?: SplitState;
  /** While bisecting: what is known so far. */
  readonly bisect?: BisectState;
  /** The conflicts over submodules (also in `conflicts`): a commit to choose, not text to merge. */
  readonly submodules?: readonly SubmoduleConflict[];
}

/** A conflict over a submodule: the commit each side records for it, and the one checked out. */
export interface SubmoduleConflict {
  readonly path: string;
  /** The current side's commit (undefined: that side removed it). */
  readonly ours?: string;
  /** The incoming side's commit (undefined: that side removed it). */
  readonly theirs?: string;
  /** The commit checked out in its folder (undefined: not checked out). */
  readonly checkedOut?: string;
}

/** A history edit stopped at a commit it splits into parts. */
export interface SplitState {
  /** The original commit being split. */
  readonly commit: string;
  readonly subject: string;
  /** Its full message: a starting point for the parts, and what is left at the end gets it. */
  readonly message: string;
  /**
   * Its changes are back in the working tree, uncommitted (HEAD is on its parent, or on the last
   * part). False while it is still whole: git got there outside Lanefold, or stopped on a conflict.
   */
  readonly opened: boolean;
  /** The parts committed so far, oldest first. */
  readonly parts: readonly { readonly sha: string; readonly subject: string }[];
}

/** A bisect in progress: the commits marked, what is left to test, and the result once found. */
export interface BisectState {
  /** The newest commit marked bad. */
  readonly bad?: string;
  readonly good: readonly string[];
  readonly skipped: readonly string[];
  /** Commits that may still be the first bad one (newest first; at most a few thousand). */
  readonly suspects: readonly string[];
  /** How many there are in all. */
  readonly remaining: number;
  /** About how many more tests it takes. */
  readonly steps: number;
  /** The commit checked out for testing. */
  readonly current?: string;
  readonly currentSubject?: string;
  /** Found: the first bad commit. */
  readonly firstBad?: string;
  readonly firstBadSubject?: string;
  /** Where `git bisect reset` returns to (a branch name or commit). */
  readonly start?: string;
}

export interface UndoInfo {
  /** Title of the operation Undo would revert, if any. */
  readonly undo?: string;
  readonly redo?: string;
}
