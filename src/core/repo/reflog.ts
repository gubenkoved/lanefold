import type { ReflogEntry } from '../../shared/models';
import type { GitResult } from '../git/runner';
import type { Repository } from './repository';

/** Each entry's commit, reflog selector (`HEAD@{n}`), reflog subject and commit subject. */
const FORMAT = '%H%x00%gd%x00%gs%x00%s';
/** Each entry's commit and, with `--date=unix`, its time (the selector becomes `HEAD@{<time>}`). */
const TIME_FORMAT = '%H%x00%gd';

/** Splits a reflog subject ("checkout: moving from a to b", "rebase (finish): returning to …"). */
export function parseReflogSubject(subject: string): { action: string; detail: string } {
  const colon = subject.indexOf(': ');
  return colon < 0
    ? { action: subject, detail: '' }
    : { action: subject.slice(0, colon), detail: subject.slice(colon + 2) };
}

/** The number in a reflog selector: `HEAD@{3}`, or the time in `HEAD@{1700000000}`. */
function selectorNumber(selector: string): number | undefined {
  const value = /@\{(\d+)\}$/.exec(selector)?.[1];
  return value === undefined ? undefined : Number(value);
}

/**
 * Parses `git log -g -z --format=%H%x00%gd%x00%gs%x00%s` (newest first), with each entry's time
 * from {@link parseReflogTimes}, in the same order. The numbers are git's own: entries git leaves
 * out (it has no commit for them, like a renamed branch's old name) still count.
 */
export function parseReflog(stdout: string, times: readonly number[] = []): Omit<ReflogEntry, 'lost'>[] {
  const fields = stdout.split('\0');
  const entries: Omit<ReflogEntry, 'lost'>[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const sha = fields[i]!.trim();
    if (!sha) break;
    const position = entries.length;
    entries.push({
      index: selectorNumber(fields[i + 1]!) ?? position,
      sha,
      ...parseReflogSubject(fields[i + 2]!),
      time: times[position] ?? 0,
      subject: fields[i + 3]!,
    });
  }
  return entries;
}

/** Parses `git log -g -z --date=unix --format=%H%x00%gd`: each entry's commit and time, in order. */
export function parseReflogTimes(stdout: string): { sha: string; time: number }[] {
  const fields = stdout.split('\0');
  const entries: { sha: string; time: number }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const sha = fields[i]!.trim();
    if (!sha) break;
    entries.push({ sha, time: selectorNumber(fields[i + 1]!) ?? 0 });
  }
  return entries;
}

/** HEAD's reflog (newest first), with the commits no ref holds any more marked as lost. */
export async function readReflog(repo: Repository, limit: number): Promise<ReflogEntry[]> {
  const count = `--max-count=${Math.max(1, Math.floor(limit))}`;
  const options = { readOnly: true, background: true, label: 'Reflog', okExitCodes: [0, 128] } as const;
  // git shows an entry's number or its time, never both: a read for each.
  const read = () =>
    Promise.all([
      repo.git(['log', '-g', '-z', `--format=${FORMAT}`, count, 'HEAD'], options),
      repo.git(['log', '-g', '-z', '--date=unix', `--format=${TIME_FORMAT}`, count, 'HEAD'], options),
    ]);
  const parse = ([listed, timed]: readonly GitResult[]) => {
    const times = parseReflogTimes(timed!.stdout);
    const entries = parseReflog(
      listed!.stdout,
      times.map((entry) => entry.time),
    );
    const aligned =
      entries.length === times.length && entries.every((entry, index) => entry.sha === times[index]!.sha);
    return { entries, aligned };
  };
  const reads = await read();
  // No reflog yet (a fresh repository): nothing to show.
  if (reads.some((result) => result.exitCode !== 0)) return [];
  const first = parse(reads);
  // HEAD moved between the two reads: once more (the next change reads them again anyway).
  const { entries } = first.aligned ? first : parse(await read());
  const tips = [...new Set(entries.map((entry) => entry.sha))];
  let lost = new Set<string>();
  if (tips.length > 0) {
    // Commits reachable from the reflog's commits but from no branch, tag or remote branch.
    const { stdout } = await repo.git(['rev-list', '--stdin', '--not', '--branches', '--tags', '--remotes'], {
      readOnly: true,
      background: true,
      label: 'Reflog',
      stdin: `${tips.join('\n')}\n`,
    });
    lost = new Set(stdout.split('\n').filter(Boolean));
  }
  return entries.map((entry) => ({ ...entry, lost: lost.has(entry.sha) }));
}
