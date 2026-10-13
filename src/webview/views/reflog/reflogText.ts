import type { ReflogEntry } from '../../../shared/models';

/*
 * Reflog entries in words. git notes each move of HEAD in its own shorthand ("reset: moving to
 * HEAD~1", "rebase (finish): returning to refs/heads/main"), which says little once HEAD has
 * moved on: these say what happened ("Reset main to 4b533950 “Fix the build”"). Lanefold's
 * operations note their own titles ("lanefold: Check out main"). What git wrote stays available
 * as it is ({@link reflogMessage}).
 */

/** The branch HEAD was on: its name, `null` when detached, `undefined` when not known. */
export type HeadBranch = string | null | undefined;

/** The entry as git wrote it ("checkout: moving from main to topic"). */
export function reflogMessage(entry: Pick<ReflogEntry, 'action' | 'detail'>): string {
  return entry.detail ? `${entry.action}: ${entry.detail}` : entry.action;
}

/** What a step of a rebase did to a commit, by the step's name in the reflog. */
const STEPS: Readonly<Record<string, string>> = {
  pick: 'picked',
  reword: 'reworded',
  edit: 'edited',
  squash: 'squashed',
  fixup: 'fixed up',
  continue: 'continued with',
  merge: 'merged',
  reset: 'reset to',
};

/** "rebase (pick)" → rebase, pick; "commit (amend)" → commit, amend; "merge topic" → as it is. */
function splitAction(action: string): { verb: string; step?: string } {
  const match = /^(.*?) \(([a-z][a-z-]*)\)$/.exec(action);
  return match ? { verb: match[1]!, step: match[2] } : { verb: action };
}

/** rebase, rebase -i, pull --rebase… */
const isRebase = (verb: string) => /^rebase\b/.test(verb) || /^pull\b.*(?:--rebase|-r)\b/.test(verb);

/** A rebase step git added to a Lanefold title: "Rebase topic onto main (pick): Fix it". */
function lanefoldStep(text: string): { title: string; step: string; rest: string } | undefined {
  const match = /^(.*) \(([a-z]+)\)(?:: (.*))?$/s.exec(text);
  const step = match?.[2];
  if (!match || !step || !(step === 'start' || step === 'finish' || step === 'abort' || STEPS[step]))
    return undefined;
  return { title: match[1]!, step, rest: match[3] ?? '' };
}

const quote = (text: string) => `“${text}”`;
const short = (sha: string) => sha.slice(0, 8);
const isHash = (text: string) => /^[0-9a-f]{7,64}$/i.test(text);
const isFullHash = (text: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(text);
/** A revision written relative to another ("HEAD~1", "main^2", "HEAD@{1}"): says little later. */
const isExpression = (text: string) => /[~^@{}:]/.test(text);

/** A branch's name from its full one ("refs/heads/main"). */
function branchOf(ref: string | undefined): string | undefined {
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
}

/**
 * A revision as the entry recorded it: a name stays (origin/main, v1.0); a hash or an expression
 * ("HEAD~2") becomes the commit it led to, with its subject.
 */
function revision(text: string, entry: ReflogEntry): string {
  if (!isHash(text) && !isExpression(text)) return text;
  return entry.subject ? `${short(entry.sha)} ${quote(entry.subject)}` : short(entry.sha);
}

function describeRebase(
  entry: ReflogEntry,
  pull: boolean,
  step: string | undefined,
  detail: string,
  on: HeadBranch,
  rebasing: string | undefined,
): string {
  const subject = entry.subject || detail;
  if (step === 'start') {
    const onto = /^checkout (.+)$/.exec(detail)?.[1];
    if (pull) return `Started pulling${rebasing ? ` into ${rebasing}` : ''} (rebase)`;
    const target = onto ? ` onto ${revision(onto, entry)}` : '';
    return rebasing ? `Started rebasing ${rebasing}${target}` : `Started a rebase${target}`;
  }
  if (step === 'finish' || step === 'abort') {
    const branch = branchOf(/^returning to (.+)$/.exec(detail)?.[1]) ?? rebasing;
    if (step === 'abort') return branch ? `Aborted rebasing ${branch}` : 'Aborted a rebase';
    if (pull) return `Pulled${branch ? ` into ${branch}` : ''} (rebase)`;
    return branch ? `Rebased ${branch}` : 'Finished a rebase';
  }
  const doing = `${pull ? 'Pulling' : 'Rebasing'}${rebasing ? ` ${rebasing}` : ''}`;
  if (step === undefined) {
    if (detail !== 'fast-forward') return reflogMessage(entry);
    // Commits it had no need to replay: HEAD moved over them.
    if (rebasing) return `${doing}: fast-forwarded`;
    return `${pull ? 'Pulled into' : 'Rebased'}${on ? ` ${on}` : ''} (fast-forward)`;
  }
  return `${doing}: ${STEPS[step] ?? step} ${quote(subject)}`;
}

/** Lanefold's own entries: the operation's title ("Lanefold: Reset main to 4b533950"). */
function describeLanefold(entry: ReflogEntry): string {
  const text = entry.detail;
  if (!text) return 'Lanefold';
  const rebase = lanefoldStep(text);
  if (rebase) {
    const { title, step, rest } = rebase;
    if (step === 'finish') return `Lanefold: ${title}`;
    if (step === 'start') return `Lanefold: ${title} (started)`;
    if (step === 'abort') return `Lanefold: ${title} (aborted)`;
    return `Lanefold: ${title} (${STEPS[step]} ${quote(entry.subject || rest)})`;
  }
  // What git added after the title: a reset's, a merge's, or the commit made.
  if (text.endsWith(': updating HEAD')) return `Lanefold: ${text.slice(0, -': updating HEAD'.length)}`;
  if (text.endsWith(': Fast-forward'))
    return `Lanefold: ${text.slice(0, -': Fast-forward'.length)} (fast-forward)`;
  const merged = /^(.*): Merge made by the '[^']+' strategy\.$/s.exec(text);
  if (merged) return `Lanefold: ${merged[1]}`;
  if (entry.subject && text.endsWith(`: ${entry.subject}`)) {
    const title = text.slice(0, -(entry.subject.length + 2));
    const reverted = /^Revert "(.*)"$/s.exec(entry.subject)?.[1];
    return `Lanefold: ${title} ${quote(reverted ?? entry.subject)}`;
  }
  return `Lanefold: ${text}`;
}

function describe(entry: ReflogEntry, on: HeadBranch, rebasing: string | undefined): string {
  if (entry.action === 'lanefold') return describeLanefold(entry);
  const { verb, step } = splitAction(entry.action);
  const detail = entry.detail;
  const subject = entry.subject || detail;
  if (verb === 'commit')
    return step === 'amend' ? `Amended ${quote(subject)}` : `Committed ${quote(subject)}`;
  if (verb === 'checkout') {
    const target = /^moving from .+ to (.+)$/s.exec(detail)?.[1];
    if (target === undefined) return reflogMessage(entry);
    // A branch when HEAD is known to have stayed on it, or by its looks when not known.
    const branch =
      on === undefined ? !isFullHash(target) && !isExpression(target) && !isHash(target) : on === target;
    return branch ? `Checked out ${target}` : `Checked out ${revision(target, entry)} (detached HEAD)`;
  }
  if (verb === 'reset') {
    const which = on ? `${on} ` : on === null ? 'HEAD ' : '';
    return `Reset ${which}to ${short(entry.sha)}${entry.subject ? ` ${quote(entry.subject)}` : ''}`;
  }
  if (isRebase(verb)) return describeRebase(entry, verb.startsWith('pull'), step, detail, on, rebasing);
  if (verb.startsWith('merge ')) {
    const sources = verb.slice('merge '.length).split(' ').join(', ');
    const fast = detail === 'Fast-forward' ? ' (fast-forward)' : '';
    return `Merged ${sources}${on ? ` into ${on}` : ''}${fast}`;
  }
  if (verb === 'pull') {
    const how =
      detail === 'Fast-forward' ? ' (fast-forward)' : /^Merge made by/.test(detail) ? ' (merge)' : '';
    return `Pulled${on ? ` into ${on}` : ''}${how}`;
  }
  if (verb === 'cherry-pick') return `Cherry-picked ${quote(subject)}`;
  if (verb === 'revert') {
    const reverted = /^Revert "(.*)"$/s.exec(detail)?.[1];
    return reverted !== undefined ? `Reverted ${quote(reverted)}` : `Committed ${quote(subject)}`;
  }
  if (verb === 'am') return `Applied the patch ${quote(subject)}`;
  if (verb === 'Branch') {
    const renamed = /^renamed refs\/heads\/(.+) to refs\/heads\/(.+)$/s.exec(detail);
    if (renamed) return `Renamed ${renamed[1]} to ${renamed[2]}`;
  }
  if (verb === 'clone') {
    const from = /^from (.+)$/s.exec(detail)?.[1];
    if (from) return `Cloned from ${from}`;
  }
  return reflogMessage(entry);
}

/**
 * Where HEAD was before an entry, from where it was after: what the older entries happened on.
 * `rebasing` is the branch a rebase replays, known from its end, between its end and its start.
 */
function before(
  entry: ReflogEntry,
  on: HeadBranch,
  rebasing: string | undefined,
): { on: HeadBranch; rebasing: string | undefined } {
  let { verb, step } = splitAction(entry.action);
  let detail = entry.detail;
  if (entry.action === 'lanefold') {
    const rebase = lanefoldStep(entry.detail);
    if (rebase) [verb, step, detail] = ['rebase', rebase.step, rebase.rest];
    else {
      // Lanefold's switches note only their title: where HEAD was before is not known. The
      // others (a commit, a reset, a merge) end with what git added and stay on the branch.
      const stays =
        /: (?:updating HEAD|Fast-forward|Merge made by the '[^']+' strategy\.)$/s.test(entry.detail) ||
        (!!entry.subject && entry.detail.endsWith(`: ${entry.subject}`));
      return { on: stays ? on : undefined, rebasing };
    }
  }
  if (verb === 'checkout') {
    const from = /^moving from (.+) to .+$/s.exec(detail)?.[1];
    return { on: from === undefined ? undefined : isFullHash(from) ? null : from, rebasing };
  }
  if (verb === 'Branch') {
    const renamed = /^renamed refs\/heads\/(.+) to refs\/heads\/(.+)$/s.exec(detail);
    if (renamed && (on === renamed[2] || on === undefined)) return { on: renamed[1], rebasing };
  }
  if (isRebase(verb) && step !== undefined) {
    // During a rebase HEAD is detached; before its start, it was on the branch it replays.
    if (step === 'finish' || step === 'abort') {
      const branch = branchOf(/^returning to (.+)$/.exec(detail)?.[1]);
      return { on: null, rebasing: branch };
    }
    if (step === 'start') return { on: rebasing, rebasing: undefined };
    return { on: null, rebasing };
  }
  return { on, rebasing };
}

/**
 * Each entry in words, newest first. `head` is the branch HEAD is on now: the entries before the
 * newest switch of branch happened on it, and so back through the history.
 */
export function describeReflog(entries: readonly ReflogEntry[], head: HeadBranch): string[] {
  const titles: string[] = [];
  let on = head;
  let rebasing: string | undefined;
  for (const entry of entries) {
    titles.push(describe(entry, on, rebasing));
    ({ on, rebasing } = before(entry, on, rebasing));
  }
  return titles;
}
