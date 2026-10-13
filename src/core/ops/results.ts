/*
 * What an operation's result says: how the refs moved, what a stash operation did, and git's
 * failures in plain words.
 */

import type { Operation, OperationResult, RefState, StashChange } from '../../shared/operations';
import { filesInUse, GitError, outputLines, type FileInUse } from '../git/errors';
import { describePaths } from '../util/wording';
import { short } from './operations';
import { diffRefStates, headMoved, shortRef } from './refState';
import { describeRemoteFailure } from './syncResults';
import { pastTense } from './verbs';

/** What moved, in words ("main → 1a2b3c4d, feature deleted"). */
export function describeChanges(before: RefState, after: RefState): string {
  const parts: string[] = [];
  if (headMoved(before, after)) parts.push(`HEAD → ${after.branch ?? short(after.head)}`);
  for (const change of diffRefStates(before, after)) {
    const name = shortRef(change.ref);
    if (!change.to) parts.push(`${name} deleted`);
    else if (!change.from) parts.push(`${name} created at ${short(change.to)}`);
    else parts.push(`${name} → ${short(change.to)}`);
  }
  return parts.join(', ') || 'Nothing changed';
}

/**
 * What moved, for the confirmation of an operation whose headline already says what it did
 * (“Deleted branch x”): a deleted ref says where it was, and a plain switch needs no words.
 */
export const NOTHING_CHANGED = 'Nothing changed';

export function describeDone(before: RefState, after: RefState): string {
  const changes = diffRefStates(before, after);
  const moved = headMoved(before, after);
  if (moved && changes.length === 0) return '';
  const parts: string[] = [];
  if (moved) parts.push(`HEAD → ${after.branch ?? short(after.head)}`);
  for (const change of changes) {
    const name = shortRef(change.ref);
    if (!change.to) parts.push(`${name} was at ${short(change.from)}`);
    else if (!change.from) parts.push(`${name} created at ${short(change.to)}`);
    else parts.push(`${name} → ${short(change.to)}`);
  }
  return parts.join(', ') || NOTHING_CHANGED;
}

/** Text in quotes (“…”); quotes inside it become single ones (‘…’). */
export function quote(text: string): string {
  return `“${text.replace(/“/g, '‘').replace(/”/g, '’')}”`;
}

/** The first sentence of a message, without its period (a confirmation’s headline). */
export function firstSentence(message: string): string {
  const end = message.search(/\.(?:\s|$)/);
  return end < 0 ? message : message.slice(0, end);
}

export const SAVED_WORK = ' Your changes since git stopped were saved as stash@{0}.';

/** A stop of an operation that set uncommitted changes aside. */
export const CARRIED_WAIT =
  ' Your uncommitted changes wait on the stash list: they come back once it is done or aborted.';

/** It is over, and the changes it set aside are back. */
export const CARRIED_BACK = ' Your uncommitted changes are back.';

export function describeError(error: unknown): string {
  return error instanceof GitError
    ? describeGitFailure(error)
    : error instanceof Error
      ? error.message
      : String(error);
}

/** What a stash operation did, for the toast. */
export function stashMessage(operation: Operation, change: StashChange | undefined): string | undefined {
  switch (operation.kind) {
    case 'stashPush':
      return change?.created ? 'Saved as stash@{0}.' : 'Nothing was stashed.';
    case 'stashApply':
      return change?.removed
        ? 'Changes restored; the stash is off the list.'
        : 'Changes restored; the stash stays on the list.';
    case 'stashDrop':
      return 'Removed from the stash list.';
    default:
      return undefined;
  }
}

/** The result of a step taken inside a stopped operation (a part committed while splitting, say). */
export function stepResult(title: string, failure: unknown, head: string | undefined): OperationResult {
  if (!failure) {
    return {
      status: 'done',
      title,
      outcome: pastTense(title),
      message: `Its commit: ${short(head)}. Commit the next part, or continue to commit what is left.`,
    };
  }
  const error = failure instanceof GitError ? failure : undefined;
  return {
    status: 'failed',
    title,
    message: error ? describeGitFailure(error) : String(failure),
    errorKind: error?.kind,
    files: error?.files,
  };
}

/** Why a push was rejected, in plain words (git's reason in parentheses). */
const PUSH_REJECTIONS: [RegExp, string][] = [
  [
    /\(stale info\)/,
    'the remote branch changed since your last fetch, so the lease refused to overwrite it. Fetch, review what arrived, then push again.',
  ],
  [
    /\((?:fetch first|non-fast-forward)\)/,
    'the remote has commits you do not have yet. Pull first, then push.',
  ],
  [/\(already exists\)/, 'a tag with that name already exists on the remote.'],
];

/** What usually holds files git could not replace. */
const holders = (count: number) =>
  `another program may have ${count === 1 ? 'it' : 'them'} open, such as an editor, a build or antivirus`;

/** Files git could not replace or write, with git's reason: "dir/a.txt (Permission denied)". */
function namedInUse(files: readonly FileInUse[]): string {
  const reason = files.find((file) => file.reason)?.reason;
  return `${describePaths(files.map((file) => file.path))}${reason ? ` (${reason})` : ''}`;
}

/** A file git could not replace or write: what usually holds it, and what to do. */
function describeFileInUse(error: GitError): string {
  const files = filesInUse(error.stderr);
  if (files.length === 0)
    return `Git could not replace ${error.files[0] ?? 'a file'}: ${holders(1)}. Close it, then retry.`;
  const writing = files.every((file) => file.writing);
  return `Git could not ${writing ? 'write' : 'replace'} ${namedInUse(files)}: ${holders(files.length)}. Close it, then retry.`;
}

/**
 * Files git left with their old content, though the command succeeded (a checkout goes on past
 * a file it cannot replace): what holds them, and what to do. Short: its toast has two buttons.
 */
export function describeStaleFiles(files: readonly FileInUse[]): string {
  const them = files.length === 1 ? 'it' : 'them';
  const reason = files.find((file) => file.reason)?.reason;
  return `${describePaths(files.map((file) => file.path))} still ${files.length === 1 ? 'has' : 'have'} the old content: git could not update ${them}${reason ? ` (${reason})` : ''}. Close the program that has ${them} open, then update ${them}.`;
}

/** After a failure half-way: what git had written is back as it was (see halfDone). */
export const PUT_BACK = 'What git had already changed is back as before.';

/** The most useful line of a git failure (git's own words, minus "error:"/"fatal:"). */
export function describeGitFailure(error: GitError): string {
  if (error.kind === 'identityUnknown')
    return 'Git does not know your name and email yet, so it cannot record commits.';
  if (error.kind === 'fileInUse') return describeFileInUse(error);
  // Talking to a remote: what stood in the way, plainly.
  const remote = describeRemoteFailure(error);
  if (remote) return remote;
  const raw = outputLines(error.stderr)
    .map((line) => line.trim())
    .filter(Boolean);
  // Lanefold's own sequence editor explains a refused history edit best.
  const ours = raw.find((line) => line.startsWith('lanefold: '));
  if (ours) return ours.slice('lanefold: '.length);
  const rejected = raw.find((line) => /^! \[(?:remote )?rejected\]/.test(line));
  if (rejected) {
    const reason = PUSH_REJECTIONS.find(([pattern]) => pattern.test(rejected));
    const what = rejected.replace(/^! \[(?:remote )?rejected\]\s*/, '');
    return reason ? `Push rejected: ${reason[1]}` : `Push rejected: ${what}`;
  }
  const strip = (line: string) => line.replace(/^(?:error|fatal|hint|remote): /, '');
  const important = raw.find((line) => /^(?:fatal|error): /.test(line));
  return strip(important ?? raw[0] ?? '') || error.message;
}
