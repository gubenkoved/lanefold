import { formatCommand } from './args';

export type GitErrorKind =
  | 'dirtyWorkTree'
  | 'fileInUse'
  | 'untrackedOverwritten'
  | 'unmergedPaths'
  | 'conflict'
  | 'nonFastForward'
  | 'noUpstream'
  | 'lockFile'
  | 'authFailed'
  | 'networkError'
  | 'notARepository'
  | 'unsafeRepository'
  | 'badRevision'
  | 'refExists'
  | 'branchNotFullyMerged'
  | 'nothingToCommit'
  | 'operationInProgress'
  | 'signingFailed'
  | 'hookRejected'
  | 'identityUnknown'
  | 'cancelled'
  | 'spawnFailed'
  | 'unknown';

export interface GitErrorInfo {
  readonly kind: GitErrorKind;
  /** Files named by git in the error (e.g. the ones that would be overwritten). */
  readonly files: readonly string[];
}

/**
 * Git's output as lines. Progress ("Rebasing (3/19)") ends with a carriage return only, so the
 * line after it starts there, not after the next newline.
 */
export function outputLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** A file git could not replace, write or remove (on Windows, mostly one another program has open). */
export interface FileInUse {
  readonly path: string;
  /** Git was writing a new file (else replacing or removing one). */
  readonly writing: boolean;
  /** Git's reason ("Permission denied", "Invalid argument"), when it gave one. */
  readonly reason?: string;
}

/** The reasons that tell of a file held open, rather than of a full disk, say. */
const HELD = '(Permission denied|Invalid argument|Device or resource busy|Resource busy)';
const IN_USE: readonly [RegExp, boolean][] = [
  [/unable to unlink old '(.+?)'(?::\s*(.+))?$/, false],
  [new RegExp(`unable to create file (.+?): ${HELD}\\s*$`), true],
  [new RegExp(`unable to write file '(.+?)' mode \\d+: ${HELD}\\s*$`), true],
  [/(?:Unlink of file|Deletion of directory) '(.+?)' failed/, false],
];

/** Every file git says it could not replace, write or remove, in the order it named them. */
export function filesInUse(text: string): FileInUse[] {
  const found = new Map<string, FileInUse>();
  for (const line of outputLines(text)) {
    for (const [pattern, writing] of IN_USE) {
      const match = pattern.exec(line);
      if (!match) continue;
      const path = match[1]!;
      const reason = match[2]?.trim() || undefined;
      if (!found.has(path)) found.set(path, { path, writing, ...(reason ? { reason } : {}) });
      break;
    }
  }
  return [...found.values()];
}

/** What git prints on the way (progress, hints), as opposed to what went wrong. */
const PROGRESS = /^(?:Rebasing \(\d+\/\d+\)|Executing: |Applying: |Auto-merging |hint:)/;

/** Lines git prints as an indented file list after a header line (tab-indented). */
function indentedFilesAfter(text: string, header: RegExp): string[] {
  const lines = outputLines(text);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return [];
  const files: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s+\S/.test(line)) break;
    files.push(line.trim());
  }
  return files;
}

/** Maps git's stderr/stdout to a structured error kind the UI can act on. */
export function classifyGitError(stderr: string, stdout = ''): GitErrorInfo {
  const text = `${stderr}\n${stdout}`;
  const none: string[] = [];

  // A file git could not replace, create or remove: on Windows, mostly one another program has
  // open (an editor, a build, antivirus).
  const inUse = filesInUse(text);
  if (inUse.length > 0) return { kind: 'fileInUse', files: inUse.map((file) => file.path) };
  if (/Your local changes to the following files would be overwritten/.test(text)) {
    return {
      kind: 'dirtyWorkTree',
      files: indentedFilesAfter(text, /Your local changes to the following files would be overwritten/),
    };
  }
  // Cherry-pick and revert with anything staged.
  if (/your local changes would be overwritten by (?:cherry-pick|revert)/.test(text)) {
    return { kind: 'dirtyWorkTree', files: none };
  }
  if (/untracked working tree files would be (?:overwritten|removed)/.test(text)) {
    return {
      kind: 'untrackedOverwritten',
      files: indentedFilesAfter(text, /untracked working tree files would be (?:overwritten|removed)/),
    };
  }
  if (
    /^CONFLICT \(/m.test(text) ||
    /could not apply [0-9a-f]+/.test(text) ||
    /Automatic merge failed/.test(text)
  ) {
    const files: string[] = [];
    for (const match of text.matchAll(/^CONFLICT \([^)]*\): .*? in (.+)$/gm)) files.push(match[1]!.trim());
    return { kind: 'conflict', files };
  }
  if (/you need to resolve your current index first|needs merge|Unmerged paths|unmerged files/i.test(text)) {
    return { kind: 'unmergedPaths', files: none };
  }
  if (/\[rejected\]|\(non-fast-forward\)|\(fetch first\)|Updates were rejected/.test(text)) {
    return { kind: 'nonFastForward', files: none };
  }
  if (/has no upstream branch|no tracking information for the current branch/.test(text)) {
    return { kind: 'noUpstream', files: none };
  }
  if (/index\.lock': File exists|Another git process seems to be running|cannot lock ref/.test(text)) {
    return { kind: 'lockFile', files: none };
  }
  if (
    /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed/.test(
      text,
    )
  ) {
    return { kind: 'authFailed', files: none };
  }
  if (
    /Could not resolve host|Connection (?:timed out|refused)|unable to access|Could not read from remote repository/.test(
      text,
    )
  ) {
    return { kind: 'networkError', files: none };
  }
  if (/detected dubious ownership in repository/i.test(text)) {
    return { kind: 'unsafeRepository', files: none };
  }
  if (/not a git repository/i.test(text)) {
    return { kind: 'notARepository', files: none };
  }
  if (/a branch named '.*' already exists|tag '.*' already exists/.test(text)) {
    return { kind: 'refExists', files: none };
  }
  if (/is not fully merged/.test(text)) {
    return { kind: 'branchNotFullyMerged', files: none };
  }
  if (/nothing to commit|nothing added to commit|no changes added to commit/.test(text)) {
    return { kind: 'nothingToCommit', files: none };
  }
  if (
    /unknown revision|bad revision|ambiguous argument|invalid reference|not a valid object name|Needed a single revision|not a valid commit/i.test(
      text,
    )
  ) {
    return { kind: 'badRevision', files: none };
  }
  if (
    /(?:rebase|merge|cherry-pick|revert|am) (?:is )?(?:already )?in progress|You have not concluded your merge/i.test(
      text,
    )
  ) {
    return { kind: 'operationInProgress', files: none };
  }
  if (
    /Please tell me who you are|unable to auto-detect email address|empty ident name|(?:Author|Committer) identity unknown/i.test(
      text,
    )
  ) {
    return { kind: 'identityUnknown', files: none };
  }
  if (/gpg failed to sign|error: (?:ssh|gpg) .*sign|failed to write commit object/i.test(text)) {
    return { kind: 'signingFailed', files: none };
  }
  if (/hook (?:declined|failed)|pre-commit hook|commit-msg hook/i.test(text)) {
    return { kind: 'hookRejected', files: none };
  }
  return { kind: 'unknown', files: none };
}

export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly files: readonly string[];

  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout: string,
    info: GitErrorInfo = classifyGitError(stderr, stdout),
  ) {
    const firstLine =
      outputLines(stderr).find((line) => line.trim().length > 0 && !PROGRESS.test(line)) ??
      `exit code ${exitCode}`;
    super(`${formatCommand(args)} failed: ${firstLine.replace(/^(?:fatal|error): /, '')}`);
    this.name = 'GitError';
    this.kind = info.kind;
    this.files = info.files;
  }
}
