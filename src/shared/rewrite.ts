/**
 * Visual history editing (interactive rebase) as data: what the user arranged in the editor,
 * how it groups into resulting commits, and the rebase todo that produces it.
 */

/**
 * `split` stops like `edit` (it is an `edit` line in git's todo), then takes the commit apart:
 * its changes go back to the working tree, uncommitted, to be committed in parts.
 */
export type RewriteAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop' | 'split';

export const REWRITE_ACTIONS: readonly RewriteAction[] = [
  'pick',
  'reword',
  'edit',
  'squash',
  'fixup',
  'drop',
  'split',
];

export interface RewriteEntry {
  readonly sha: string;
  readonly action: RewriteAction;
  /**
   * The message of the commit this entry starts (reword), or the final message of a group
   * that squashes commits into it. Ignored for squash/fixup/drop entries.
   */
  readonly message?: string;
}

/** A commit of the edited range, as the editor shows it. */
export interface RewriteCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  /** Author date, seconds since epoch. */
  readonly authorTime: number;
  readonly subject: string;
  /** The full message (subject, blank line, body). */
  readonly message: string;
}

/** The commits after `base` up to HEAD, oldest first. */
export interface RewriteRange {
  readonly base: string | null;
  readonly head: string;
  readonly branch?: string;
  readonly commits: readonly RewriteCommit[];
  /** Merge commits in the range (history with merges cannot be edited this way). */
  readonly merges: number;
  /** More commits than the editor accepts (`commits` is empty then). */
  readonly tooMany?: number;
}

export type RewriteStepStatus = 'clean' | 'conflict' | 'empty' | 'unknown';

/** What git is predicted to do at one entry of the plan. */
export interface RewriteStep {
  readonly sha: string;
  readonly status: RewriteStepStatus;
  /** Files that conflict at this step. */
  readonly files?: readonly string[];
}

/** A dry run of a plan with `git merge-tree`, which never touches the working tree. */
export interface RewriteSimulation {
  /** False when there is no dry run (see `skipped`). */
  readonly supported: boolean;
  /**
   * Why not: the installed git cannot make one (merge-tree --merge-base needs git 2.40), or too
   * many commits to replay while arranging.
   */
  readonly skipped?: 'git' | 'size';
  /** Per entry (dropped entries are left out), in todo order. */
  readonly steps: readonly RewriteStep[];
}

/** A resulting commit: a kept entry plus the squash/fixup entries folded into it. */
export interface RewriteGroup {
  readonly head: RewriteEntry;
  readonly members: readonly RewriteEntry[];
  /** True when the result gets a new message (reword, or anything squashed in). */
  readonly newMessage: boolean;
}

/** Why an arrangement cannot be applied, and the commit it is about (to point at in the editor). */
export interface RewriteProblem {
  readonly kind:
    | 'empty'
    | 'duplicate'
    | 'action'
    | 'nothing-left'
    | 'squash-first'
    | 'split-root'
    | 'split-folded'
    | 'no-message';
  readonly message: string;
  readonly sha?: string;
}

/**
 * What can be wrong with an arrangement, in words for the editor. `fromRoot`: the edit starts
 * at the very first commit (no base).
 */
export function rewriteProblem(
  entries: readonly RewriteEntry[],
  options: { readonly fromRoot?: boolean } = {},
): RewriteProblem | undefined {
  if (entries.length === 0) return { kind: 'empty', message: 'There are no commits to edit.' };
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.sha)) return { kind: 'duplicate', message: 'A commit appears twice.', sha: entry.sha };
    seen.add(entry.sha);
    if (!REWRITE_ACTIONS.includes(entry.action)) {
      return { kind: 'action', message: `Unknown action “${String(entry.action)}”.`, sha: entry.sha };
    }
  }
  const firstKept = entries.find((entry) => entry.action !== 'drop');
  // From the very first commit, git would leave an empty commit of its own in their place.
  if (!firstKept && options.fromRoot) {
    return {
      kind: 'nothing-left',
      message: 'Every commit of the history is dropped: a branch needs at least one, so keep one of them.',
    };
  }
  if (firstKept && (firstKept.action === 'squash' || firstKept.action === 'fixup')) {
    return {
      kind: 'squash-first',
      message: 'The oldest remaining commit cannot be squashed: there is nothing below it to squash into.',
      sha: firstKept.sha,
    };
  }
  // Splitting goes back to the commit's parent; the first commit of the history has none.
  if (options.fromRoot && firstKept?.action === 'split') {
    return {
      kind: 'split-root',
      message: 'The first commit of the history cannot be split: there is no commit before it to go back to.',
      sha: firstKept.sha,
    };
  }
  for (const group of groupRewrite(entries)) {
    const sha = group.head.sha;
    if (group.head.action === 'split' && group.members.length > 0) {
      return {
        kind: 'split-folded',
        message:
          'A commit being split cannot have other commits folded into it. Fold them into another commit, or split it in a separate edit.',
        sha,
      };
    }
    if (group.head.action === 'reword' && !cleanMessage(group.head.message ?? '')) {
      return { kind: 'no-message', message: 'A reworded commit needs a message.', sha };
    }
    // An explicit message that was cleared (the editor keeps it empty while typing).
    if (group.newMessage && group.head.message !== undefined && !cleanMessage(group.head.message)) {
      return { kind: 'no-message', message: 'The combined commit needs a message.', sha };
    }
  }
  return undefined;
}

/** {@link rewriteProblem} in words only. */
export function validateRewrite(
  entries: readonly RewriteEntry[],
  options: { readonly fromRoot?: boolean } = {},
): string | undefined {
  return rewriteProblem(entries, options)?.message;
}

/** Groups entries (oldest first) into the commits the rebase will produce. */
export function groupRewrite(entries: readonly RewriteEntry[]): RewriteGroup[] {
  const groups: { head: RewriteEntry; members: RewriteEntry[] }[] = [];
  for (const entry of entries) {
    if (entry.action === 'drop') continue;
    if ((entry.action === 'squash' || entry.action === 'fixup') && groups.length > 0) {
      groups[groups.length - 1]!.members.push(entry);
    } else {
      groups.push({ head: entry, members: [] });
    }
  }
  return groups.map(({ head, members }) => ({
    head,
    members,
    newMessage: head.action === 'reword' || members.some((member) => member.action === 'squash'),
  }));
}

/**
 * Commit message cleanup as git does without an editor: trailing whitespace removed from each
 * line, leading/trailing blank lines dropped, runs of blank lines collapsed. Empty → ''.
 */
export function cleanMessage(message: string): string {
  const lines = message
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * The default message of a group: the head's message, followed by the messages of the
 * commits squashed into it (fixups contribute changes only), like git's own squash.
 */
export function defaultGroupMessage(
  group: RewriteGroup,
  messageOf: (sha: string) => string | undefined,
): string {
  const parts = [group.head, ...group.members.filter((member) => member.action === 'squash')]
    .map((entry) => cleanMessage(messageOf(entry.sha) ?? ''))
    .filter(Boolean);
  return parts.join('\n\n');
}

/** The message a group ends up with. */
export function groupMessage(group: RewriteGroup, messageOf: (sha: string) => string | undefined): string {
  if (!group.newMessage) return cleanMessage(messageOf(group.head.sha) ?? '');
  const explicit = cleanMessage(group.head.message ?? '');
  return explicit || defaultGroupMessage(group, messageOf);
}

/**
 * Removes changes that change nothing: a reword to the same message becomes a pick, and a
 * message given to a pick is ignored. Keeps plans (and hashes) stable.
 */
export function normalizeRewrite(
  entries: readonly RewriteEntry[],
  messageOf: (sha: string) => string | undefined,
): RewriteEntry[] {
  return entries.map((entry) => {
    if (entry.action === 'reword') {
      const message = cleanMessage(entry.message ?? '');
      return message === cleanMessage(messageOf(entry.sha) ?? '')
        ? { sha: entry.sha, action: 'pick' }
        : { sha: entry.sha, action: 'reword', message };
    }
    if (entry.action === 'pick' || entry.action === 'edit') {
      // A message on a pick/edit only matters when squashes join it (it is the group message).
      return entry.message === undefined ? entry : { ...entry, message: cleanMessage(entry.message) };
    }
    return { sha: entry.sha, action: entry.action };
  });
}

/**
 * Index (oldest first) of the first entry that differs from the original history: commits before
 * it keep their hashes (git fast-forwards over them). `entries.length` when nothing changes.
 * Expects normalized entries (see {@link normalizeRewrite}).
 */
export function firstChange(entries: readonly RewriteEntry[], original: readonly string[]): number {
  // A pick that something is folded into is amended, so it changes too.
  const amended = new Set<string>();
  for (const group of groupRewrite(entries)) {
    if (group.members.length > 0 || group.newMessage) amended.add(group.head.sha);
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.sha !== original[i] || entry.action !== 'pick' || amended.has(entry.sha)) return i;
  }
  return entries.length;
}

/** The rebase todo as lines, plus where refs pointing at each original commit end up. */
export interface TodoLayout {
  readonly lines: readonly string[];
  /**
   * Original commit → index of the line after which a branch pointing at it is updated
   * (`update-ref`): the end of the group it was folded into or, for a dropped commit, of the
   * nearest older commit that stays. -1: before every line (the branch ends up at the base).
   */
  readonly anchors: Readonly<Record<string, number>>;
}

/**
 * The rebase todo (oldest first). Every new message is applied by a "carrier": an empty
 * commit holding just that message, folded in with `fixup -C`. The todo therefore never
 * contains `reword` or `squash`, so git never opens an editor, and continuing after a
 * conflict works the same from Lanefold or a terminal.
 *
 * `carrierOf(group)` returns the carrier commit (or a placeholder for previews); `original`
 * is the commits in their original order, oldest first.
 */
export function layoutTodo(
  entries: readonly RewriteEntry[],
  carrierOf: (group: RewriteGroup) => string,
  original: readonly string[],
): TodoLayout {
  const lines: string[] = [];
  const end = new Map<string, number>();
  for (const group of groupRewrite(entries)) {
    // A split is an edit stop to git; Lanefold takes the commit apart when git stops there.
    const stops = group.head.action === 'edit' || group.head.action === 'split';
    lines.push(`${stops ? 'edit' : 'pick'} ${group.head.sha}`);
    for (const member of group.members) lines.push(`fixup ${member.sha}`);
    if (group.newMessage) lines.push(`fixup -C ${carrierOf(group)}`);
    for (const entry of [group.head, ...group.members]) end.set(entry.sha, lines.length - 1);
  }
  // Explicit drops (git checks that no commit silently disappears).
  for (const entry of entries) if (entry.action === 'drop') lines.push(`drop ${entry.sha}`);
  const anchors: Record<string, number> = {};
  let previous = -1;
  for (const sha of original) {
    const at = end.get(sha);
    if (at !== undefined) previous = at;
    anchors[sha] = at ?? previous;
  }
  return { lines, anchors };
}

/** The todo text, with `update-ref` lines for refs pointing at original commits. */
export function renderTodo(layout: TodoLayout, refsAt?: (sha: string) => readonly string[]): string {
  const after = new Map<number, string[]>();
  if (refsAt) {
    for (const [sha, index] of Object.entries(layout.anchors)) {
      for (const ref of refsAt(sha)) {
        let list = after.get(index);
        if (!list) after.set(index, (list = []));
        list.push(`update-ref ${ref}`);
      }
    }
  }
  const lines = [...(after.get(-1) ?? [])];
  layout.lines.forEach((line, index) => lines.push(line, ...(after.get(index) ?? [])));
  return `${lines.join('\n')}\n`;
}

/** The commits to split, in todo order. */
export function splitCommits(entries: readonly RewriteEntry[]): string[] {
  return entries.filter((entry) => entry.action === 'split').map((entry) => entry.sha);
}

/** The commit whose tree a group's carrier copies: the last one folded into the group. */
export function groupTip(group: RewriteGroup): string {
  return (group.members.length > 0 ? group.members[group.members.length - 1]! : group.head).sha;
}

/** The original arrangement: every commit picked, in order. */
export function pickAll(commits: readonly { readonly sha: string }[]): RewriteEntry[] {
  return commits.map((commit) => ({ sha: commit.sha, action: 'pick' }));
}

/**
 * Squashes `selected` (any order) into the oldest of them: the others move right after it,
 * keeping their relative order. Entries are oldest first.
 */
export function squashSelection(
  entries: readonly RewriteEntry[],
  selected: ReadonlySet<string>,
  action: 'squash' | 'fixup' = 'squash',
): RewriteEntry[] {
  const chosen = entries.filter((entry) => selected.has(entry.sha));
  if (chosen.length < 2) return [...entries];
  const [target, ...rest] = chosen;
  const out: RewriteEntry[] = [];
  for (const entry of entries) {
    if (entry === target) {
      out.push(target.action === 'drop' ? { sha: target.sha, action: 'pick' } : target);
      for (const member of rest) out.push({ sha: member.sha, action });
    } else if (!selected.has(entry.sha)) out.push(entry);
  }
  return out;
}

/** Moves `sha` to right after `target` (oldest-first order) and folds it in with `action`. */
export function foldInto(
  entries: readonly RewriteEntry[],
  sha: string,
  target: string,
  action: 'squash' | 'fixup',
): RewriteEntry[] {
  const moving = entries.find((entry) => entry.sha === sha);
  if (!moving || sha === target) return [...entries];
  const out: RewriteEntry[] = [];
  for (const entry of entries) {
    if (entry.sha === sha) continue;
    out.push(entry);
    if (entry.sha === target) out.push({ sha, action });
  }
  // Commits that were squashed into the moved one stay where they were, folding into its old
  // neighbour; that is what the editor shows.
  return out;
}

/**
 * Folds several commits into `target` like {@link foldInto}, keeping their order among
 * themselves: `shas` oldest first, each lands right after the one before it.
 */
export function foldManyInto(
  entries: readonly RewriteEntry[],
  shas: readonly string[],
  target: string,
  action: 'squash' | 'fixup',
): RewriteEntry[] {
  let out = [...entries];
  let after = target;
  for (const sha of shas) {
    if (sha === target) continue;
    out = foldInto(out, sha, after, action);
    after = sha;
  }
  return out;
}

const AUTOSQUASH = /^(fixup|squash|amend)! /;

/** Commits whose subject asks to be folded into another ("fixup! …", "squash! …", "amend! …"). */
export function autosquashCandidates(commits: readonly RewriteCommit[]): number {
  return commits.filter((commit) => AUTOSQUASH.test(commit.subject)).length;
}

/**
 * Arranges "fixup! …", "squash! …" and "amend! …" commits like `git rebase --autosquash`: each
 * moves right after the commit its subject names (by subject, or hash prefix), after earlier
 * fixups of the same commit. "amend!" replaces the target's message with its own (minus the
 * marker line). Commits whose target is not found stay where they are.
 */
export function autosquash(
  entries: readonly RewriteEntry[],
  commits: readonly RewriteCommit[],
): RewriteEntry[] {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const order = entries.map((entry) => entry.sha);
  const placed = new Map<string, RewriteEntry[]>();
  const moved = new Set<string>();
  const messages = new Map<string, string>();
  for (let i = 0; i < order.length; i++) {
    const commit = bySha.get(order[i]!);
    if (!commit) continue;
    let subject = commit.subject;
    const match = AUTOSQUASH.exec(subject);
    if (!match) continue;
    const kind = match[1] as 'fixup' | 'squash' | 'amend';
    // "fixup! fixup! X" folds into X too.
    while (AUTOSQUASH.test(subject)) subject = subject.replace(AUTOSQUASH, '');
    const earlier = order
      .slice(0, i)
      .filter((sha) => !moved.has(sha))
      .map((sha) => bySha.get(sha)!);
    const target =
      earlier.find((c) => c.subject === subject) ??
      (/^[0-9a-f]{4,64}$/.test(subject) ? earlier.find((c) => c.sha.startsWith(subject)) : undefined) ??
      earlier.find((c) => c.subject.startsWith(subject));
    if (!target) continue;
    moved.add(commit.sha);
    const list = placed.get(target.sha) ?? [];
    list.push({ sha: commit.sha, action: kind === 'squash' ? 'squash' : 'fixup' });
    placed.set(target.sha, list);
    if (kind === 'amend') {
      const body = commit.message.split('\n').slice(1).join('\n');
      const message = cleanMessage(body);
      if (message) messages.set(target.sha, message);
    }
  }
  if (moved.size === 0) return [...entries];
  const out: RewriteEntry[] = [];
  const append = (entry: RewriteEntry) => {
    const message = messages.get(entry.sha);
    // An amend! message replaces the target's: a plain pick becomes a reword for it to apply.
    out.push(
      message ? { ...entry, action: entry.action === 'pick' ? 'reword' : entry.action, message } : entry,
    );
    for (const follower of placed.get(entry.sha) ?? []) append(follower);
  };
  for (const entry of entries) if (!moved.has(entry.sha)) append(entry);
  return out;
}
