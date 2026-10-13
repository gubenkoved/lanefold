import { existsSync } from 'node:fs';
import { isObjectId } from '../../shared/oid';
import type { BisectState, OpState, WorkState } from '../../shared/operations';
import { filePaths } from '../git/args';
import { resolveCommit } from '../git/queries';
import { readSplit } from '../rebase/split';
import type { Repository } from '../repo/repository';
import { readText } from '../util/files';
import { readWorkState, sameWorkState } from './snapshot';

/** Written into `rebase-merge/` by Lanefold's sequence editor: the rebase is a history edit. */
export const HISTORY_EDIT_MARKER = 'lanefold-plan.json';

/** Paths with unresolved conflicts (unmerged index entries). */
export async function conflictedPaths(repo: Repository): Promise<string[]> {
  const { stdout } = await repo.git(['diff', '--name-only', '--diff-filter=U', '-z'], {
    readOnly: true,
    background: true,
    label: 'Conflicted files',
  });
  return [...new Set(stdout.split('\0').filter(Boolean))];
}

/** Which conflict stages the index has for a path (1 base, 2 current side, 3 incoming side). */
export async function conflictStages(repo: Repository, path: string): Promise<Set<number>> {
  const { stdout } = await repo.git(['ls-files', '--unmerged', '-z', ...filePaths(path)], {
    readOnly: true,
    background: true,
    label: 'Conflicted files',
  });
  const stages = new Set<number>();
  for (const entry of stdout.split('\0')) {
    // "<mode> <object> <stage>\t<path>"
    const stage = /^\d+ [0-9a-f]+ ([1-3])\t/.exec(entry)?.[1];
    if (stage) stages.add(Number(stage));
  }
  return stages;
}

async function subjectOf(repo: Repository, commit: string | undefined): Promise<string | undefined> {
  if (!commit) return undefined;
  const result = await repo.git(['log', '-1', '--format=%s', '--end-of-options', commit], {
    readOnly: true,
    background: true,
    label: 'Commit subject',
    okExitCodes: [0, 128],
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

/** A local branch (preferred), remote branch or tag at a commit: a name for a side of a conflict. */
async function refAt(repo: Repository, commit: string | undefined): Promise<string | undefined> {
  if (!isObjectId(commit)) return undefined;
  const { stdout } = await repo.git(
    [
      'for-each-ref',
      `--points-at=${commit}`,
      '--format=%(refname)',
      'refs/heads/',
      'refs/remotes/',
      'refs/tags/',
    ],
    { readOnly: true, background: true, label: 'Operation state' },
  );
  const refs = stdout.split('\n').filter((ref) => ref && !ref.endsWith('/HEAD'));
  const ref =
    refs.find((name) => name.startsWith('refs/heads/')) ??
    refs.find((name) => name.startsWith('refs/remotes/')) ??
    refs.find((name) => name.startsWith('refs/tags/'));
  return ref?.replace(/^refs\/(?:heads|remotes|tags)\//, '');
}

/** Todo-list commands that replay a commit. */
const REPLAY = /^(?:p|pick|r|reword|e|edit|s|squash|f|fixup)\s+(?:-[cC]\s+\S+\s+)?([0-9a-f]{4,64})\b/;
const MAX_STEPS = 5000;

/** A rebase's todo lists: the commands done and still to do (comments and blanks left out). */
interface TodoLists {
  readonly done: readonly string[];
  readonly todo: readonly string[];
  /**
   * A step git could not carry out goes back to the top of the todo (it is the last one done
   * too, once per attempt): that command line, and how many attempts more than one there were.
   */
  readonly rescheduled?: { readonly line: string; readonly repeats: number };
}

async function readTodoLists(repo: Repository): Promise<TodoLists> {
  const [done, todo] = await Promise.all([
    readText(repo.gitPath('rebase-merge/done')),
    readText(repo.gitPath('rebase-merge/git-rebase-todo')),
  ]);
  const commands = (text: string | undefined) =>
    (text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  const lists = { done: commands(done), todo: commands(todo) };
  const last = lists.done.at(-1);
  if (!last || last !== lists.todo[0] || !REPLAY.test(last)) return lists;
  let attempts = 0;
  while (lists.done[lists.done.length - 1 - attempts] === last) attempts++;
  return { ...lists, rescheduled: { line: last, repeats: attempts - 1 } };
}

/** The commits of a rebase in progress: replayed so far (`done`) and still to come (`todo`). */
async function rebaseSteps(repo: Repository, lists: TodoLists): Promise<OpState['steps']> {
  const ids = (lines: readonly string[]) =>
    lines
      .map((line) => REPLAY.exec(line)?.[1])
      .filter((id): id is string => !!id)
      .slice(0, MAX_STEPS);
  // A step to do again is not done.
  const attempts = lists.rescheduled ? lists.rescheduled.repeats + 1 : 0;
  const [doneIds, todoIds] = [ids(lists.done.slice(0, lists.done.length - attempts)), ids(lists.todo)];
  if (doneIds.length + todoIds.length === 0) return undefined;
  // A todo list written by hand may abbreviate: resolve every ID to the full one.
  const short = [...doneIds, ...todoIds].filter((id) => !isObjectId(id));
  const full = new Map<string, string>();
  if (short.length > 0) {
    const { stdout } = await repo.git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
      readOnly: true,
      background: true,
      label: 'Operation state',
      stdin: `${short.join('\n')}\n`,
    });
    stdout.split('\n').forEach((line, index) => {
      const [object, type] = line.split(' ');
      if (type === 'commit' && object) full.set(short[index]!, object);
    });
  }
  const resolve = (list: string[]) => list.map((id) => full.get(id) ?? id).filter((id) => id.length >= 40);
  return { done: resolve(doneIds), todo: resolve(todoIds) };
}

/**
 * A step git could not carry out for a reason other than a conflict (a file it could not write,
 * say): git puts it back at the top of the todo, so the last step done is the next one again.
 */
async function rescheduledStep(repo: Repository, lists: TodoLists): Promise<OpState['failedStep']> {
  const id = lists.rescheduled && REPLAY.exec(lists.rescheduled.line)?.[1];
  const commit = id ? await resolveCommit(repo, id) : undefined;
  return commit ? { commit, subject: await subjectOf(repo, commit) } : undefined;
}

/** The commit message git prepared (MERGE_MSG), without its comment lines. */
async function preparedMessage(repo: Repository): Promise<string | undefined> {
  const text = await readText(repo.gitPath('MERGE_MSG'));
  if (!text) return undefined;
  const { stdout } = await repo.git(['config', '--get', 'core.commentChar'], {
    readOnly: true,
    background: true,
    okExitCodes: [0, 1],
  });
  const configured = stdout.trim();
  const comment = configured && configured !== 'auto' ? configured : '#';
  const message = text
    .split('\n')
    .filter((line) => !line.startsWith(comment))
    .join('\n')
    .trim();
  return message || undefined;
}

/**
 * The operation git is in the middle of, from the state files in the git dir (per worktree):
 * rebase-merge/ and rebase-apply/ (rebase, am), MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD,
 * BISECT_LOG.
 */
export async function readOpState(repo: Repository): Promise<OpState> {
  const path = (name: string) => repo.gitPath(name);
  if (existsSync(path('rebase-merge'))) {
    const [step, total, headName, onto, stopped] = await Promise.all([
      readText(path('rebase-merge/msgnum')),
      readText(path('rebase-merge/end')),
      readText(path('rebase-merge/head-name')),
      readText(path('rebase-merge/onto')),
      readText(path('rebase-merge/stopped-sha')),
    ]);
    const lists = await readTodoLists(repo);
    const [conflicts, commitSubject, ontoRef, steps] = await Promise.all([
      conflictedPaths(repo),
      subjectOf(repo, stopped),
      refAt(repo, onto),
      rebaseSteps(repo, lists),
    ]);
    const planFile = path(`rebase-merge/${HISTORY_EDIT_MARKER}`);
    const split = existsSync(planFile) ? await readSplit(repo, { planFile, conflicts }) : undefined;
    // `amend` is written when git stops at an `edit` line (not for conflicts).
    const editStop = conflicts.length === 0 && existsSync(path('rebase-merge/amend'));
    const failedStep = conflicts.length === 0 && !editStop ? await rescheduledStep(repo, lists) : undefined;
    // Each attempt at a step that fails again counts in git's numbers: the step is one step.
    const repeats = failedStep ? (lists.rescheduled?.repeats ?? 0) : 0;
    return {
      kind: 'rebase',
      step: step ? Number(step) - repeats : undefined,
      total: total ? Number(total) - repeats : undefined,
      branch: headName?.replace(/^refs\/heads\//, ''),
      onto,
      ontoRef,
      steps,
      commit: stopped ?? failedStep?.commit,
      commitSubject: commitSubject ?? failedStep?.subject,
      conflicts,
      editStop,
      historyEdit: existsSync(path(`rebase-merge/${HISTORY_EDIT_MARKER}`)),
      ...(split ? { split } : {}),
      ...(failedStep ? { failedStep } : {}),
    };
  }
  if (existsSync(path('rebase-apply'))) {
    const am = existsSync(path('rebase-apply/applying'));
    const [step, total, headName, info] = await Promise.all([
      readText(path('rebase-apply/next')),
      readText(path('rebase-apply/last')),
      readText(path('rebase-apply/head-name')),
      am ? readText(path('rebase-apply/info')) : undefined,
    ]);
    return {
      kind: am ? 'am' : 'rebase',
      step: step ? Number(step) : undefined,
      total: total ? Number(total) : undefined,
      branch: headName?.replace(/^refs\/heads\//, ''),
      // The patch being applied: its subject, from the mail headers git extracted.
      commitSubject: info ? /^Subject: (.*)$/m.exec(info)?.[1] : undefined,
      conflicts: await conflictedPaths(repo),
    };
  }
  for (const [file, kind] of [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ] as const) {
    const commit = (await readText(path(file)))?.split('\n')[0];
    if (commit) {
      const [conflicts, commitSubject, head, incomingRef, message] = await Promise.all([
        conflictedPaths(repo),
        subjectOf(repo, commit),
        repo.head(),
        refAt(repo, commit),
        preparedMessage(repo),
      ]);
      return { kind, commit, commitSubject, branch: head.branch, incomingRef, message, conflicts };
    }
  }
  const sequence = await sequenceInProgress(repo);
  if (sequence) return sequence;
  if (existsSync(path('BISECT_LOG')))
    return { kind: 'bisect', conflicts: [], bisect: await readBisect(repo) };
  return { conflicts: [] };
}

/**
 * A sequence of cherry-picks or reverts with no pick in progress (no CHERRY_PICK_HEAD): git
 * could not carry out the next one (a file it could not write, say), or the one that stopped was
 * committed by hand. Git left HEAD at `abort-safety`: while it is still there, the next pick is a
 * step that failed (and `--continue` would leave it out without a word).
 */
async function sequenceInProgress(repo: Repository): Promise<OpState | undefined> {
  const todo = await readText(repo.gitPath('sequencer/todo'));
  const next = (todo ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
  const match = next ? /^(pick|p|revert|r)\s+([0-9a-f]{4,64})\b/.exec(next) : null;
  if (!match) return undefined;
  const kind = match[1]!.startsWith('r') ? 'revert' : 'cherry-pick';
  const [commit, safety, head, conflicts] = await Promise.all([
    resolveCommit(repo, match[2]!),
    readText(repo.gitPath('sequencer/abort-safety')),
    repo.head(),
    conflictedPaths(repo),
  ]);
  const commitSubject = await subjectOf(repo, commit);
  const failed = conflicts.length === 0 && safety?.trim() === head.sha;
  return {
    kind,
    commit,
    commitSubject,
    branch: head.branch,
    conflicts,
    ...(failed && commit ? { failedStep: { commit, subject: commitSubject } } : {}),
  };
}

/** The commits a sequence of picks or reverts has still to do (in order), and how it runs them. */
export async function sequenceTodo(repo: Repository): Promise<{ commits: string[]; options: string[] }> {
  const [todo, opts] = await Promise.all([
    readText(repo.gitPath('sequencer/todo')),
    readText(repo.gitPath('sequencer/opts')),
  ]);
  const commits = (todo ?? '')
    .split('\n')
    .map((line) => /^(?:pick|p|revert|r)\s+([0-9a-f]{4,64})\b/.exec(line.trim())?.[1])
    .filter((id): id is string => !!id);
  // `git config` format: [options] record-origin = true, mainline = 1…
  const values = new Map<string, string[]>();
  for (const line of (opts ?? '').split('\n')) {
    const pair = /^\s*([a-z-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (pair) values.set(pair[1]!, [...(values.get(pair[1]!) ?? []), pair[2]!]);
  }
  const on = (key: string) => values.get(key)?.at(-1) === 'true';
  const options = [
    ...(on('record-origin') ? ['-x'] : []),
    ...(on('signoff') ? ['--signoff'] : []),
    ...(on('allow-empty') ? ['--allow-empty'] : []),
    ...(on('allow-empty-message') ? ['--allow-empty-message'] : []),
    ...(on('keep-redundant-commits') ? ['--keep-redundant-commits'] : []),
    ...(values.get('mainline')?.at(-1) ? ['--mainline', values.get('mainline')!.at(-1)!] : []),
    ...(values.get('strategy')?.at(-1) ? [`--strategy=${values.get('strategy')!.at(-1)!}`] : []),
    ...(values.get('strategy-option') ?? []).map((option) => `--strategy-option=${option}`),
  ];
  return { commits, options };
}

/**
 * The commit HEAD was on when the operation in progress started. It tells one rebase or merge
 * from another: a record of a stop applies only to the operation that stopped.
 */
export async function operationOrigin(repo: Repository, state: OpState): Promise<string | undefined> {
  const file = (name: string) => readText(repo.gitPath(name));
  const head = async () => (await repo.head()).sha ?? '';
  switch (state.kind) {
    case 'rebase':
    case 'am': {
      const dir = existsSync(repo.gitPath('rebase-merge')) ? 'rebase-merge' : 'rebase-apply';
      const [orig, onto] = await Promise.all([file(`${dir}/orig-head`), file(`${dir}/onto`)]);
      return orig ? `${orig}+${onto ?? ''}` : undefined;
    }
    case 'cherry-pick':
    case 'revert': {
      // A sequence of picks records where it started; a single pick has not moved HEAD yet.
      const started = await file('sequencer/head');
      if (started) return started;
      const picked = await file(state.kind === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD');
      return `${await head()}+${picked ?? ''}`;
    }
    case 'merge':
      return `${await head()}+${(await file('MERGE_HEAD'))?.split('\n')[0] ?? ''}`;
    default:
      return undefined;
  }
}

/** What git left when an operation stopped, to tell later whether anything changed since. */
export interface StopRecord {
  /** The stopped operation (see {@link operationOrigin}). */
  readonly origin?: string;
  readonly files: WorkState;
  /** Why the last step failed, in plain words (a step git could not carry out). */
  readonly reason?: string;
}

/**
 * Whether the index or working tree hold work that aborting or skipping would discard: changes
 * made since git stopped (resolutions, edits). For a stop Lanefold did not see, anything
 * uncommitted counts.
 */
export async function workSinceStop(
  repo: Repository,
  state: OpState,
  stop: StopRecord | undefined,
): Promise<boolean> {
  const { stdout } = await repo.git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
    readOnly: true,
    background: true,
    label: 'Uncommitted changes',
  });
  // Nothing uncommitted at all: nothing to lose, whatever happened since the last stop Lanefold
  // saw (the operation may have been continued in a terminal).
  if (stdout.length === 0) return false;
  if (stop?.origin && stop.origin === (await operationOrigin(repo, state)))
    return !sameWorkState(await readWorkState(repo), stop.files);
  // Otherwise what git would discard: changes to tracked files. Untracked files are left be,
  // except the new files of a commit being split (its abort tracks them first).
  const untrackedCount = !!state.split?.opened;
  return stdout.split('\0').some((entry) => entry && (untrackedCount || !entry.startsWith('?? ')));
}

/** Suspects listed in the bisect state (the count is exact either way). */
const MAX_SUSPECTS = 5000;

/** What `git bisect` knows so far, from refs/bisect/* and BISECT_START. */
export async function readBisect(repo: Repository): Promise<BisectState> {
  const [{ stdout: refs }, start, head] = await Promise.all([
    repo.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/bisect/'], {
      readOnly: true,
      background: true,
      label: 'Bisect state',
    }),
    readText(repo.gitPath('BISECT_START')),
    repo.head(),
  ]);
  let bad: string | undefined;
  const good: string[] = [];
  const skipped: string[] = [];
  for (const line of refs.split('\n')) {
    const [name, sha] = line.split(' ');
    if (!name || !sha) continue;
    if (name === 'refs/bisect/bad') bad = sha;
    else if (name.startsWith('refs/bisect/good-')) good.push(sha);
    else if (name.startsWith('refs/bisect/skip-')) skipped.push(sha);
  }
  let suspects: string[] = [];
  let remaining = 0;
  if (bad && good.length > 0) {
    const range = ['--end-of-options', bad, ...good.map((sha) => `^${sha}`)];
    const [list, count] = await Promise.all([
      repo.git(['rev-list', `--max-count=${MAX_SUSPECTS}`, ...range], { readOnly: true, background: true }),
      repo.git(['rev-list', '--count', ...range], { readOnly: true, background: true }),
    ]);
    suspects = list.stdout.split('\n').filter(Boolean);
    remaining = Number(count.stdout.trim()) || 0;
  }
  // Only the bad commit itself is left: it is the first bad one.
  const firstBad = bad && remaining === 1 ? bad : undefined;
  const testable = Math.max(1, remaining - skipped.filter((sha) => suspects.includes(sha)).length);
  const [currentSubject, firstBadSubject] = await Promise.all([
    subjectOf(repo, head.sha),
    subjectOf(repo, firstBad),
  ]);
  return {
    bad,
    good,
    skipped,
    suspects,
    remaining,
    steps: firstBad ? 0 : Math.ceil(Math.log2(testable)),
    current: head.sha,
    currentSubject,
    firstBad,
    firstBadSubject,
    start: start || undefined,
  };
}
