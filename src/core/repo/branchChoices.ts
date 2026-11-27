import { parseStatus } from '../parsers/status';
import type { Repository } from './repository';

/** A branch to offer in a picker (switch to, compare with). */
export interface BranchChoice {
  /** Short name: "main", "origin/feature". */
  readonly name: string;
  readonly kind: 'branch' | 'remote';
  readonly sha: string;
  /** Committer date of its tip (seconds). */
  readonly time: number;
  readonly subject: string;
  readonly upstream?: string;
  readonly ahead?: number;
  readonly behind?: number;
  /** The upstream was deleted on the remote. */
  readonly gone?: boolean;
  readonly current: boolean;
}

const FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(committerdate:unix)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(HEAD)',
  '%(symref)',
  '%(subject)',
].join('%00');

/** Local and remote-tracking branches, most recently committed first. */
export async function branchChoices(repo: Repository): Promise<BranchChoice[]> {
  const { stdout } = await repo.git(
    ['for-each-ref', '--sort=-committerdate', `--format=${FORMAT}`, 'refs/heads/', 'refs/remotes/'],
    { readOnly: true, background: true, label: 'List branches' },
  );
  const choices: BranchChoice[] = [];
  for (const line of stdout.split('\n')) {
    const [ref, sha, time, upstream, track, head, symref, ...subject] = line.split('\0');
    if (!ref || !sha || symref) continue; // refs/remotes/origin/HEAD and the like
    const local = ref.startsWith('refs/heads/');
    const ahead = /ahead (\d+)/.exec(track ?? '')?.[1];
    const behind = /behind (\d+)/.exec(track ?? '')?.[1];
    choices.push({
      name: ref.replace(/^refs\/(?:heads|remotes)\//, ''),
      kind: local ? 'branch' : 'remote',
      sha,
      time: Number(time) || 0,
      subject: subject.join('\0'),
      upstream: upstream || undefined,
      ahead: ahead ? Number(ahead) : undefined,
      behind: behind ? Number(behind) : undefined,
      gone: track === '[gone]' || undefined,
      current: head === '*',
    });
  }
  return choices;
}

/** Branches checked out recently, newest first (from HEAD's reflog), without the current one. */
export async function recentBranches(repo: Repository, limit = 6): Promise<string[]> {
  const result = await repo.git(['reflog', 'show', '--format=%gs', '-n', '400', 'HEAD', '--'], {
    readOnly: true,
    background: true,
    label: 'Recent branches',
    okExitCodes: [0, 128],
  });
  if (result.exitCode !== 0) return [];
  const recent: string[] = [];
  for (const line of result.stdout.split('\n')) {
    // "checkout: moving from main to feature/login"
    const from = /^checkout: moving from (\S+) to \S+$/.exec(line)?.[1];
    if (from && !/^[0-9a-f]{7,64}$/.test(from) && !recent.includes(from)) recent.push(from);
    if (recent.length > limit) break;
  }
  const { branch } = await repo.head();
  return recent.filter((name) => name !== branch).slice(0, limit);
}

/** Branches to rebase the checked-out one onto, in the order a picker lists them. */
export interface RebaseTargets {
  /** Local branches checked out lately, the latest first. */
  readonly recent: readonly BranchChoice[];
  /** The other local branches, most recently committed first. */
  readonly branches: readonly BranchChoice[];
  /** Every remote branch (a branch is as often rebased onto `origin/main` as onto `main`). */
  readonly remotes: readonly BranchChoice[];
}

/**
 * Orders `choices` (see {@link branchChoices}) as targets of a rebase: the checked-out branch is
 * left out, and the branches named in `recent` (see {@link recentBranches}) come first.
 */
export function rebaseTargets(choices: readonly BranchChoice[], recent: readonly string[]): RebaseTargets {
  const local = choices.filter((choice) => choice.kind === 'branch' && !choice.current);
  return {
    recent: recent
      .map((name) => local.find((choice) => choice.name === name))
      .filter((choice): choice is BranchChoice => !!choice),
    branches: local.filter((choice) => !recent.includes(choice.name)),
    remotes: choices.filter((choice) => choice.kind === 'remote'),
  };
}

/** The checked-out branch and how it stands against its upstream (as of the last fetch). */
export interface HeadStatus {
  readonly branch?: string;
  readonly sha?: string;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
}

export async function headStatus(repo: Repository): Promise<HeadStatus> {
  const { stdout } = await repo.git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], {
    readOnly: true,
    background: true,
    label: 'Branch status',
  });
  const { branch } = parseStatus(stdout);
  const name = branch.head && branch.head !== '(detached)' ? branch.head : undefined;
  const sha = branch.oid && branch.oid !== '(initial)' ? branch.oid : undefined;
  return {
    branch: name,
    sha,
    upstream: branch.upstream,
    ahead: branch.ahead ?? 0,
    behind: branch.behind ?? 0,
  };
}

/** Whether the working tree has untracked files (that are not ignored). */
export async function hasUntrackedFiles(repo: Repository): Promise<boolean> {
  const { stdout } = await repo.git(['status', '--porcelain=v2', '-z', '--untracked-files=normal'], {
    readOnly: true,
    background: true,
    label: 'Untracked files',
  });
  return parseStatus(stdout).entries.some((entry) => entry.kind === 'untracked');
}
