import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  groupRewrite,
  groupMessage,
  groupTip,
  layoutTodo,
  type RewriteCommit,
  type RewriteEntry,
  type RewriteRange,
  type RewriteSimulation,
  type RewriteStep,
} from '../../shared/rewrite';
import { revisions } from '../git/args';
import { INTERNAL_IDENTITY } from '../git/identity';
import type { Repository } from '../repo/repository';

/** The most commits the history editor takes at once. */
export const MAX_REWRITE_COMMITS = 1000;
/** Beyond this many commits after the first change, the dry run is skipped (too slow to be live). */
const MAX_SIMULATED_STEPS = 300;

/** A commit of the range plus its tree (for the dry run). */
export interface RangeCommit extends RewriteCommit {
  readonly tree: string;
}

export interface Range extends RewriteRange {
  readonly commits: readonly RangeCommit[];
}

const rangeRevs = (base: string | null) => (base ? revisions('HEAD', `^${base}`) : revisions('HEAD'));

/**
 * The commits after `base` up to HEAD, oldest first, with full messages. `base` must be an
 * ancestor of HEAD (or `null` for the whole history). Counts merges instead of listing them.
 */
export async function readRewriteRange(
  repo: Repository,
  base: string | null,
  limit = MAX_REWRITE_COMMITS,
): Promise<Range | undefined> {
  const head = await repo.head();
  if (!head.sha) return undefined;
  const count = async (extra: string[]) => {
    const { stdout } = await repo.git(['rev-list', '--count', ...extra, ...rangeRevs(base)], {
      readOnly: true,
      background: true,
      label: 'Commits to edit',
    });
    return Number(stdout.trim()) || 0;
  };
  const [total, merges] = await Promise.all([count([]), count(['--merges'])]);
  if (total > limit)
    return { base, head: head.sha, branch: head.branch, commits: [], merges, tooMany: total };
  const { stdout } = await repo.git(
    [
      'log',
      '--reverse',
      '--topo-order',
      '-z',
      '--format=%H%x00%P%x00%T%x00%aN%x00%aE%x00%at%x00%B',
      ...rangeRevs(base),
    ],
    { readOnly: true, background: true, label: 'Commits to edit' },
  );
  const fields = stdout.split('\0');
  const commits: RangeCommit[] = [];
  for (let i = 0; i + 6 < fields.length; i += 7) {
    const message = fields[i + 6]!.replace(/\s+$/, '');
    commits.push({
      sha: fields[i]!.trim(),
      parents: fields[i + 1]!.split(' ').filter(Boolean),
      tree: fields[i + 2]!,
      authorName: fields[i + 3]!,
      authorEmail: fields[i + 4]!,
      authorTime: Number(fields[i + 5]) || 0,
      subject: message.split('\n', 1)[0] ?? '',
      message,
    });
  }
  return { base, head: head.sha, branch: head.branch, commits, merges };
}

async function internalCommit(repo: Repository, tree: string, parents: string[], message: string) {
  const { stdout } = await repo.git(
    ['commit-tree', '--no-gpg-sign', ...parents.flatMap((p) => ['-p', p]), '-F', '-', tree],
    { env: INTERNAL_IDENTITY, stdin: message, background: true, label: 'History edit' },
  );
  return stdout.trim();
}

/**
 * Creates the carrier commits that hold the new messages: same tree as the group's last
 * commit, that commit as parent, the message as the only content. Applied with `fixup -C`,
 * a carrier changes no file and replaces the message, keeping the original author.
 */
export async function createCarriers(
  repo: Repository,
  entries: readonly RewriteEntry[],
  messageOf: (sha: string) => string | undefined,
): Promise<Map<string, string>> {
  /** Group head → carrier. */
  const carriers = new Map<string, string>();
  for (const group of groupRewrite(entries)) {
    if (!group.newMessage) continue;
    const tip = groupTip(group);
    carriers.set(
      group.head.sha,
      await internalCommit(repo, `${tip}^{tree}`, [tip], `${groupMessage(group, messageOf)}\n`),
    );
  }
  return carriers;
}

const TODO_LINE = /^(?:pick|edit|drop|fixup(?: -C)?) [0-9a-f]{40,64}$/;

export interface RebaseScript {
  /** Node (or Electron in node mode) to run the sequence editor with. */
  readonly node: string;
  readonly sequenceEditor: string;
}

/**
 * The environment that makes git run Lanefold's sequence editor: through git's shell, with the
 * paths in variables so they are never re-parsed, and ELECTRON_RUN_AS_NODE reaching only this
 * command (not hooks).
 */
export function sequenceEditorEnv(script: RebaseScript): Record<string, string> {
  return {
    GIT_SEQUENCE_EDITOR: 'ELECTRON_RUN_AS_NODE=1 "$LANEFOLD_NODE" "$LANEFOLD_SEQ"',
    LANEFOLD_NODE: script.node,
    LANEFOLD_SEQ: script.sequenceEditor,
  };
}

/**
 * Runs `git rebase -i <args>` with Lanefold's sequence editor, which installs the planned todo
 * after checking that git is about to rebase exactly `expected` (oldest first).
 */
export async function runPlannedRebase(
  repo: Repository,
  script: RebaseScript,
  options: {
    readonly args: readonly string[];
    readonly expected: readonly string[];
    readonly entries: readonly RewriteEntry[];
    readonly messageOf: (sha: string) => string | undefined;
    readonly env: Record<string, string>;
    readonly label: string;
    readonly info: Record<string, unknown>;
  },
): Promise<void> {
  const carriers = await createCarriers(repo, options.entries, options.messageOf);
  const layout = layoutTodo(options.entries, (group) => carriers.get(group.head.sha) ?? '', options.expected);
  // git would stop on a line it cannot parse, mid-rebase: never hand it one.
  const bad = layout.lines.find((line) => !TODO_LINE.test(line));
  if (bad !== undefined) throw new Error(`Internal error: unexpected todo line “${bad}”.`);
  const planPath = join(tmpdir(), `lanefold-rebase-${randomUUID()}.json`);
  await writeFile(
    planPath,
    JSON.stringify({
      ...options.info,
      expected: options.expected,
      lines: layout.lines,
      anchors: layout.anchors,
    }),
  );
  try {
    await repo.git(['rebase', ...options.args], {
      label: options.label,
      env: {
        ...options.env,
        ...sequenceEditorEnv(script),
        LANEFOLD_REBASE_PLAN: planPath,
        // No step needs a message from an editor (new messages come from carriers).
        GIT_EDITOR: 'true',
      },
    });
  } finally {
    await rm(planPath, { force: true });
  }
}

/**
 * After a finished history edit: which commit each original commit became. Pairs the plan's
 * groups with the new commits of base..HEAD (oldest first) and checks that each pair has the
 * same author and author date. `undefined` when they do not line up (e.g. a step was skipped).
 * A split commit became its parts plus what was left (which kept its author and date): it maps
 * to that last one.
 */
export async function mapRewritten(
  repo: Repository,
  base: string | null,
  groups: readonly (readonly string[])[],
  authorOf: (sha: string) => { name: string; time: number } | undefined,
  splits: readonly string[] = [],
): Promise<Record<string, string> | undefined> {
  const { stdout } = await repo.git(
    ['log', '--reverse', '-z', '--format=%H%x00%aN%x00%at', ...rangeRevs(base)],
    {
      readOnly: true,
      background: true,
      label: 'Map rewritten commits',
    },
  );
  const fields = stdout.split('\0');
  const commits: { sha: string; name: string; time: number }[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    commits.push({ sha: fields[i]!.trim(), name: fields[i + 1]!, time: Number(fields[i + 2]) });
  }
  if (splits.length === 0 && commits.length !== groups.length) return undefined;
  const split = new Set(splits);
  const by = (sha: string | undefined) => {
    const author = sha ? authorOf(sha) : undefined;
    return (commit: { name: string; time: number }) =>
      !!author && author.name === commit.name && author.time === commit.time;
  };
  const map: Record<string, string> = {};
  let next = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    let at = next;
    if (split.has(group[0]!)) {
      // What was left of it, after its parts; with nothing left, its last part (the one before
      // the next group's commit).
      const rest = commits.findIndex((commit, index) => index >= next && by(group[0])(commit));
      const following = groups[i + 1]
        ? commits.findIndex((commit, index) => index > next && by(groups[i + 1]![0])(commit))
        : commits.length;
      at = rest >= 0 ? rest : following - 1;
      if (at < next) return undefined;
    } else if (!commits[at] || !by(group[0])(commits[at]!)) return undefined;
    for (const sha of group) map[sha] = commits[at]!.sha;
    next = at + 1;
  }
  return next === commits.length ? map : undefined;
}

/** Remembers dry-run results across plans: applying commit C onto tree T always gives the same. */
export class SimulationCache {
  private readonly merges = new Map<string, { tree: string; files?: string[] }>();
  /** Tree → a commit with that tree (merge-tree takes commits before git 2.45). */
  private readonly commits = new Map<string, string>();

  merge(tree: string, commit: string): { tree: string; files?: string[] } | undefined {
    return this.merges.get(`${tree}:${commit}`);
  }

  setMerge(tree: string, commit: string, result: { tree: string; files?: string[] }): void {
    if (this.merges.size > 20_000) this.merges.clear();
    this.merges.set(`${tree}:${commit}`, result);
  }

  commitFor(tree: string): string | undefined {
    return this.commits.get(tree);
  }

  setCommit(tree: string, commit: string): void {
    if (this.commits.size > 20_000) this.commits.clear();
    this.commits.set(tree, commit);
  }
}

/**
 * Dry-runs a plan step by step with `git merge-tree --write-tree --merge-base`: each commit is
 * applied (as a cherry-pick would) onto the tree the previous steps produced. Nothing touches
 * the working tree, the index or any ref; the intermediate states are dangling commits.
 * After the first conflict the outcome depends on how it is resolved, so later steps are
 * 'unknown'.
 */
export async function simulateRewrite(
  repo: Repository,
  range: Range,
  entries: readonly RewriteEntry[],
  cache: SimulationCache,
  signal?: AbortSignal,
): Promise<RewriteSimulation> {
  if (!repo.runner.features.mergeTreeMergeBase) return { supported: false, skipped: 'git', steps: [] };
  const bySha = new Map(range.commits.map((commit) => [commit.sha, commit]));
  const order = groupRewrite(entries).flatMap((group) => [group.head, ...group.members]);
  if (order.length > MAX_SIMULATED_STEPS) return { supported: false, skipped: 'size', steps: [] };

  const emptyTree = await treeFor(repo, '');
  const treeOfCommit = async (sha: string | undefined): Promise<string> => {
    if (!sha) return emptyTree;
    const known = bySha.get(sha)?.tree;
    if (known) return known;
    const { stdout } = await repo.git(['rev-parse', ...revisions(`${sha}^{tree}`)], {
      readOnly: true,
      background: true,
    });
    return stdout.trim();
  };
  const commitWithTree = async (tree: string): Promise<string> => {
    let commit = cache.commitFor(tree);
    if (!commit) {
      commit = await internalCommit(repo, tree, [], 'lanefold dry run\n');
      cache.setCommit(tree, commit);
    }
    return commit;
  };

  let current = await treeOfCommit(range.base ?? undefined);
  if (range.base) cache.setCommit(current, range.base);
  const steps: RewriteStep[] = [];
  let blocked = false;
  for (const entry of order) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    const commit = bySha.get(entry.sha);
    if (!commit || blocked) {
      steps.push({ sha: entry.sha, status: 'unknown' });
      continue;
    }
    const parentTree = await treeOfCommit(commit.parents[0]);
    const startedEmpty = parentTree === commit.tree;
    if (current === parentTree) {
      // Exactly where it was made: it applies as is.
      steps.push({ sha: entry.sha, status: 'clean' });
      current = commit.tree;
      cache.setCommit(commit.tree, commit.sha);
      continue;
    }
    let result = cache.merge(current, commit.sha);
    if (!result) {
      const base = commit.parents[0] ?? (await commitWithTree(emptyTree));
      const ours = await commitWithTree(current);
      const merged = await repo.git(
        [
          'merge-tree',
          '--write-tree',
          '--name-only',
          '--no-messages',
          `--merge-base=${base}`,
          ...revisions(ours, commit.sha),
        ],
        { readOnly: true, background: true, label: 'Predict history edit', okExitCodes: [0, 1] },
      );
      const lines = merged.stdout.split('\n');
      result =
        merged.exitCode === 0
          ? { tree: lines[0]!.trim() }
          : { tree: lines[0]!.trim(), files: lines.slice(1).filter(Boolean) };
      cache.setMerge(current, commit.sha, result);
    }
    if (result.files) {
      steps.push({ sha: entry.sha, status: 'conflict', files: result.files });
      blocked = true;
      continue;
    }
    steps.push({
      sha: entry.sha,
      status: result.tree === current && !startedEmpty ? 'empty' : 'clean',
    });
    current = result.tree;
  }
  return { supported: true, steps };
}

/**
 * Dry-runs folding the staged changes into `target`, a commit of `range`: a commit with the
 * index's tree on top of HEAD (dangling, like the other dry-run states) is folded in right
 * after `target` as a fixup, and the commits after it are replayed.
 */
export async function simulateAmendInto(
  repo: Repository,
  range: Range,
  target: string,
): Promise<RewriteSimulation> {
  if (!repo.runner.features.mergeTreeMergeBase) return { supported: false, skipped: 'git', steps: [] };
  const { stdout } = await repo.git(['write-tree'], { background: true, label: 'Predict amend' });
  const tree = stdout.trim();
  const staged = await internalCommit(repo, tree, [range.head], 'lanefold dry run\n');
  const commits: RangeCommit[] = [
    ...range.commits,
    {
      sha: staged,
      parents: [range.head],
      tree,
      authorName: INTERNAL_IDENTITY.GIT_AUTHOR_NAME,
      authorEmail: INTERNAL_IDENTITY.GIT_AUTHOR_EMAIL,
      authorTime: 0,
      subject: 'lanefold dry run',
      message: 'lanefold dry run',
    },
  ];
  const entries: RewriteEntry[] = range.commits.flatMap((commit) =>
    commit.sha === target
      ? [
          { sha: commit.sha, action: 'pick' as const },
          { sha: staged, action: 'fixup' as const },
        ]
      : [{ sha: commit.sha, action: 'pick' as const }],
  );
  const simulation = await simulateRewrite(repo, { ...range, commits }, entries, new SimulationCache());
  // The staged changes are part of the target's step.
  return {
    ...simulation,
    steps: simulation.steps.map((step) => (step.sha === staged ? { ...step, sha: target } : step)),
  };
}

async function treeFor(repo: Repository, content: ''): Promise<string> {
  const { stdout } = await repo.git(['hash-object', '-t', 'tree', '--stdin'], {
    stdin: content,
    readOnly: true,
    background: true,
  });
  return stdout.trim();
}
