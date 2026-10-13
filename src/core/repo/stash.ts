import type { StashEntry } from '../../shared/models';
import type { Repository } from './repository';

const STASH_FORMAT = '%H%x00%P%x00%ct%x00%gs';

/** Splits a stash's reflog subject ("On main: message", "WIP on main: 1a2b3c4 subject"). */
export function parseStashSubject(subject: string): {
  message: string;
  generated: boolean;
  branch?: string;
} {
  const match = /^(WIP on|On) (.*?): ([\s\S]*)$/.exec(subject);
  if (!match) return { message: subject, generated: false };
  const branch = match[2] === '(no branch)' ? undefined : match[2];
  return { message: match[3]!, generated: match[1] === 'WIP on', branch };
}

/** Parses `git stash list -z --format=%H%x00%P%x00%ct%x00%gs`, newest first. */
export function parseStashList(stdout: string): StashEntry[] {
  const fields = stdout.split('\0');
  const entries: StashEntry[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const sha = fields[i]!.trim();
    if (!sha) break;
    const parents = fields[i + 1]!.split(' ').filter(Boolean);
    const subject = fields[i + 3]!;
    entries.push({
      index: entries.length,
      sha,
      subject,
      ...parseStashSubject(subject),
      base: parents[0] ?? '',
      untracked: parents.length > 2,
      time: Number(fields[i + 2]) || 0,
    });
  }
  return entries;
}

export async function readStashList(repo: Repository): Promise<StashEntry[]> {
  const result = await repo.git(['stash', 'list', '-z', `--format=${STASH_FORMAT}`], {
    readOnly: true,
    background: true,
    label: 'Stash list',
    okExitCodes: [0, 128],
  });
  if (result.exitCode === 0) return parseStashList(result.stdout);
  // The last stash went away while git was listing (a pop or drop running alongside).
  if (/refs\/stash/.test(result.stderr) && !(await stashTop(repo))) return [];
  throw new Error(result.stderr.trim() || 'git stash list failed');
}

/** The newest stash (refs/stash), if any. */
export async function stashTop(repo: Repository): Promise<string | undefined> {
  const result = await repo.git(['rev-parse', '-q', '--verify', 'refs/stash'], {
    readOnly: true,
    background: true,
    label: 'Newest stash',
    okExitCodes: [0, 1, 128],
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

/** The commit `stash@{index}` names right now, if there is one. */
export async function stashAt(repo: Repository, index: number): Promise<string | undefined> {
  const result = await repo.git(['rev-parse', '-q', '--verify', `refs/stash@{${index}}`], {
    readOnly: true,
    background: true,
    label: 'Stash entry',
    okExitCodes: [0, 1, 128],
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}
