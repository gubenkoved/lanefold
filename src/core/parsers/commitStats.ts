import type { CommitStats } from '../../shared/models';
import { GITLINK_MODE } from './diff';

/**
 * Flags of the read behind the graph's Files and Lines columns: `git diff-tree --stdin` takes a
 * commit per line and answers with each one's changes against its parent, a root commit's
 * against nothing, and a commit that changed nothing with its name alone. A merge is given as
 * "commit parent": compared with that parent only (its first, as a commit's file list is), which
 * every supported git does the same way. As for every diff Lanefold parses, no user diff driver
 * or textconv filter runs.
 */
export const COMMIT_STATS_FLAGS: readonly string[] = [
  '--stdin',
  '-r',
  '--root',
  '--always',
  '-z',
  '--raw',
  '-M',
  '--no-ext-diff',
  '--no-textconv',
  '--no-abbrev',
];

/** Added to {@link COMMIT_STATS_FLAGS} to count lines too (git then reads the files' contents). */
export const COMMIT_STATS_LINES_FLAG = '--numstat';

interface OpenStats {
  readonly sha: string;
  added: number;
  modified: number;
  removed: number;
  linesAdded: number;
  linesRemoved: number;
  binary: number;
  /** Whether each raw record is a submodule's, in order (the numstat records follow that order). */
  readonly gitlinks: boolean[];
  /** Numstat records read so far. */
  counted: number;
}

const COMMIT_LINE = /^([0-9a-f]{40}|[0-9a-f]{64})(?: \(from [0-9a-f]+\))?$/;

/**
 * Parses `git diff-tree --stdin -z --raw [--numstat]` (see {@link COMMIT_STATS_FLAGS}): per
 * commit its name ("sha\0", or "sha (from parent)\0" where the parent was given), then raw records
 * (":srcmode dstmode srcsha dstsha STATUS\0path\0[newpath\0]"), then with `--numstat` as many
 * records "added\tdeleted\tpath\0" (a rename's: "added\tdeleted\t\0old\0new\0"; "-" counts for a
 * binary file). Paths are skipped by position, so a file named like a commit is not one.
 *
 * A copy counts as an added file, anything else that is neither added nor deleted as changed in
 * place. A submodule's lines are git's "Subproject commit" ones: not counted.
 */
export function parseCommitStats(output: string, lines: boolean): CommitStats[] {
  const tokens = output.split('\0');
  const stats: CommitStats[] = [];
  let open: OpenStats | undefined;
  const close = () => {
    if (!open) return;
    const { sha, added, modified, removed } = open;
    stats.push(
      lines
        ? {
            sha,
            added,
            modified,
            removed,
            lines: { added: open.linesAdded, removed: open.linesRemoved, binary: open.binary },
          }
        : { sha, added, modified, removed },
    );
    open = undefined;
  };
  let i = 0;
  while (i < tokens.length) {
    // A commit's name ends its line in some outputs: the diff's own records never start with one.
    const token = tokens[i]!.replace(/^\n+/, '');
    if (token === '') {
      i++;
    } else if (token.startsWith(':')) {
      const [srcMode, dstMode, , , status = 'M'] = token.slice(1).split(' ');
      const kind = status[0];
      if (open) {
        if (kind === 'A' || kind === 'C') open.added++;
        else if (kind === 'D') open.removed++;
        else open.modified++;
        open.gitlinks.push(srcMode === GITLINK_MODE || dstMode === GITLINK_MODE);
      }
      i += kind === 'R' || kind === 'C' ? 3 : 2;
    } else if (token.includes('\t')) {
      const [added, removed, path] = token.split('\t');
      if (open && !open.gitlinks[open.counted++]) {
        if (added === '-' || removed === '-') open.binary++;
        else {
          open.linesAdded += Number(added) || 0;
          open.linesRemoved += Number(removed) || 0;
        }
      }
      // A rename's old and new paths follow as tokens of their own.
      i += path === '' || path === undefined ? 3 : 1;
    } else {
      close();
      const match = COMMIT_LINE.exec(token.trim());
      if (match)
        open = {
          sha: match[1]!,
          added: 0,
          modified: 0,
          removed: 0,
          linesAdded: 0,
          linesRemoved: 0,
          binary: 0,
          gitlinks: [],
          counted: 0,
        };
      i++;
    }
  }
  close();
  return stats;
}
