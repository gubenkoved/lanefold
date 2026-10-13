import type { WorkingTreeSummary } from '../../shared/models';

export type StatusEntryKind = 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';

export interface StatusEntry {
  readonly kind: StatusEntryKind;
  readonly path: string;
  readonly origPath?: string;
  /** Index status (X) and worktree status (Y); '.' means unchanged. */
  readonly index: string;
  readonly worktree: string;
  /** The entry is a submodule: what changed in its folder (git's `S<c><m><u>` field). */
  readonly submodule?: SubmoduleStatus;
  /**
   * The object HEAD and the index record (undefined when absent). Unmerged entries: HEAD's side
   * (stage 2) and, in `theirsOid`, the incoming side (stage 3).
   */
  readonly headOid?: string;
  readonly indexOid?: string;
  readonly theirsOid?: string;
}

/** A submodule's folder compared with the commit the index records for it. */
export interface SubmoduleStatus {
  /** Another commit is checked out. */
  readonly commitChanged: boolean;
  /** Tracked files are edited (uncommitted inside the submodule). */
  readonly modified: boolean;
  /** It has untracked files. */
  readonly untracked: boolean;
}

/** Parses porcelain v2's submodule field: "N..." for other entries, "S<c><m><u>" for submodules. */
export function parseSubmoduleField(field: string | undefined): SubmoduleStatus | undefined {
  if (!field || field[0] !== 'S') return undefined;
  return { commitChanged: field[1] === 'C', modified: field[2] === 'M', untracked: field[3] === 'U' };
}

/** An object name, or undefined for git's all-zeros "absent". */
const oid = (value: string | undefined) => (value && /[1-9a-f]/.test(value) ? value : undefined);

export interface StatusResult {
  readonly branch: {
    readonly oid?: string;
    readonly head?: string;
    readonly upstream?: string;
    readonly ahead?: number;
    readonly behind?: number;
  };
  readonly entries: readonly StatusEntry[];
  readonly stashCount?: number;
}

/** Parses `git status --porcelain=v2 --branch -z [--show-stash]`. */
export function parseStatus(output: string): StatusResult {
  const branch: { -readonly [K in keyof StatusResult['branch']]: StatusResult['branch'][K] } = {};
  const entries: StatusEntry[] = [];
  let stashCount: number | undefined;
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [, key, ...rest] = record.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid' && value !== '(initial)') branch.oid = value;
      else if (key === 'branch.head' && value !== '(detached)') branch.head = value;
      else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          branch.ahead = Number(match[1]);
          branch.behind = Number(match[2]);
        }
      } else if (key === 'stash') stashCount = Number(value);
      continue;
    }
    const type = record[0];
    if (type === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = record.split(' ');
      entries.push({
        kind: 'changed',
        index: parts[1]![0]!,
        worktree: parts[1]![1]!,
        path: parts.slice(8).join(' '),
        submodule: parseSubmoduleField(parts[2]),
        headOid: oid(parts[6]),
        indexOid: oid(parts[7]),
      });
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path\0origPath
      const parts = record.split(' ');
      entries.push({
        kind: 'renamed',
        index: parts[1]![0]!,
        worktree: parts[1]![1]!,
        path: parts.slice(9).join(' '),
        origPath: records[++i],
        submodule: parseSubmoduleField(parts[2]),
        headOid: oid(parts[6]),
        indexOid: oid(parts[7]),
      });
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = record.split(' ');
      entries.push({
        kind: 'unmerged',
        index: parts[1]![0]!,
        worktree: parts[1]![1]!,
        path: parts.slice(10).join(' '),
        submodule: parseSubmoduleField(parts[2]),
        headOid: oid(parts[8]),
        theirsOid: oid(parts[9]),
      });
    } else if (type === '?') {
      entries.push({ kind: 'untracked', index: '?', worktree: '?', path: record.slice(2) });
    } else if (type === '!') {
      entries.push({ kind: 'ignored', index: '!', worktree: '!', path: record.slice(2) });
    }
  }
  return { branch, entries, stashCount };
}

export function summarizeStatus(status: StatusResult): WorkingTreeSummary {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;
  for (const entry of status.entries) {
    if (entry.kind === 'unmerged') conflicted++;
    else if (entry.kind === 'untracked') untracked++;
    else if (entry.kind !== 'ignored') {
      if (entry.index !== '.') staged++;
      if (entry.worktree !== '.') unstaged++;
    }
  }
  return { staged, unstaged, untracked, conflicted };
}
