/*
 * The verbs of operations: what the button that runs one says, and what its confirmation says
 * once it ran.
 */

import type { Operation } from '../../shared/operations';

/** What the review sheet’s run button says for an operation (“Delete branch”, “Force push”). */
export function actionLabel(operation: Operation): string {
  switch (operation.kind) {
    case 'checkout':
      return 'Check out';
    case 'createBranch':
      return 'Create branch';
    case 'setIdentity':
      return 'Save';
    case 'deleteBranch':
      return operation.remote ? 'Delete both' : 'Delete branch';
    case 'deleteBranches':
      return 'Delete branches';
    case 'deleteRemoteBranch':
      return 'Delete from remote';
    case 'setUpstream':
      return operation.upstream === undefined ? 'Stop tracking' : 'Set upstream';
    case 'renameBranch':
      return operation.remote ? 'Rename both' : 'Rename';
    case 'renameRemote':
      return 'Rename';
    case 'moveBranch':
      return 'Move branch';
    case 'createTag':
      return 'Create tag';
    case 'deleteTag':
      return 'Delete tag';
    case 'reset':
      return 'Reset';
    case 'revert':
      return 'Revert';
    case 'cherryPick':
      return 'Cherry-pick';
    case 'merge':
      return 'Merge';
    case 'rebase':
      return 'Rebase';
    case 'rewrite':
      return 'Apply';
    case 'amendInto':
      return 'Amend';
    case 'commit':
      return operation.amend ? 'Amend' : 'Commit';
    case 'stashPush':
      return 'Stash';
    case 'stashApply':
      return operation.pop ? 'Pop' : 'Apply';
    case 'stashDrop':
      return 'Drop';
    case 'discard':
    case 'discardLines':
      return 'Discard';
    case 'restoreFiles':
      return 'Restore';
    case 'applyFileChanges':
      return operation.reverse ? 'Take out' : 'Apply';
    case 'applyPatch':
      return 'Apply';
    case 'fetch':
      return 'Fetch';
    case 'pull':
      return 'Pull';
    case 'push':
      return operation.force ? 'Force push' : 'Push';
    case 'bisectStart':
      return 'Start bisecting';
    case 'bisectMark':
      return operation.verdict === 'skip' ? 'Skip' : `Mark ${operation.verdict}`;
    case 'addWorktree':
      return 'Create worktree';
    case 'removeWorktree':
      return 'Remove worktree';
    case 'pruneWorktrees':
      return 'Prune';
    case 'updateSubmodules':
      return operation.init ? 'Initialize' : 'Update';
    case 'addSubmodule':
      return 'Add submodule';
    case 'syncSubmodules':
      return 'Sync';
    case 'deinitSubmodules':
      return 'Deinitialize';
    case 'pushTag':
      return 'Push';
    case 'deleteRemoteTag':
      return 'Delete from remote';
    case 'continue':
      return 'Continue';
    case 'skip':
      return 'Skip';
    case 'abort':
      return 'Abort';
    case 'addRemote':
      return 'Add remote';
    case 'removeRemote':
      return 'Remove remote';
    case 'setRemoteUrl':
      return 'Change URL';
    case 'startSplit':
      return 'Split';
    default:
      return 'Run';
  }
}

/** Titles’ first words in the past tense (longest first where one starts another). */
const PAST: readonly (readonly [string, string])[] = [
  ['Initialize and update', 'Initialized and updated'],
  ['Amend and continue', 'Amended and continued'],
  ['Check out', 'Checked out'],
  ['Force push', 'Force pushed'],
  ['Cherry-pick', 'Cherry-picked'],
  ['Abort', 'Aborted'],
  ['Add', 'Added'],
  ['Amend', 'Amended'],
  ['Apply', 'Applied'],
  ['Change', 'Changed'],
  ['Commit', 'Committed'],
  ['Conclude', 'Concluded'],
  ['Continue', 'Continued'],
  ['Create', 'Created'],
  ['Deinitialize', 'Deinitialized'],
  ['Delete', 'Deleted'],
  ['Discard', 'Discarded'],
  ['Drop', 'Dropped'],
  ['Edit', 'Edited'],
  ['Fetch', 'Fetched'],
  ['Finish', 'Finished'],
  ['Initialize', 'Initialized'],
  ['Mark', 'Marked'],
  ['Merge', 'Merged'],
  ['Move', 'Moved'],
  ['Open', 'Opened'],
  ['Pop', 'Popped'],
  ['Prune', 'Pruned'],
  ['Pull', 'Pulled'],
  ['Push', 'Pushed'],
  ['Rebase', 'Rebased'],
  ['Remove', 'Removed'],
  ['Rename', 'Renamed'],
  ['Reset', 'Reset'],
  ['Restore', 'Restored'],
  ['Revert', 'Reverted'],
  ['Set', 'Set'],
  ['Skip', 'Skipped'],
  ['Split', 'Split'],
  ['Stash', 'Stashed'],
  ['Stop', 'Stopped'],
  ['Sync', 'Synced'],
  ['Take', 'Took'],
  ['Unset', 'Unset'],
  ['Update', 'Updated'],
];

/**
 * A title in the past tense, for the confirmation (“Delete branch x” → “Deleted branch x”); a
 * title that does not start with a known verb stays as it is.
 */
export function pastTense(title: string): string {
  for (const [verb, past] of PAST) {
    if (title === verb || title.startsWith(`${verb} `)) return `${past}${title.slice(verb.length)}`;
  }
  return title;
}
