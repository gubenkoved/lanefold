/** Formatting helpers for graph rows and details (dates, initials, hashes, counts). */

import type { CommitLineStats, CommitStats } from '../../shared/models';

export { absoluteTime, relativeLong, relativeTime } from '../../shared/time';

const initialsCache = new Map<string, string>();

export function initials(name: string): string {
  let value = initialsCache.get(name);
  if (value === undefined) {
    value = computeInitials(name);
    if (initialsCache.size > 2000) initialsCache.clear();
    initialsCache.set(name, value);
  }
  return value;
}

function computeInitials(name: string): string {
  // Whole characters (never half of a surrogate pair), from words that start with a letter or
  // digit: "Zoë Ångström 🚀" is "ZÅ".
  const words = name
    .normalize('NFC')
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word)[0] ?? '')
    .filter((first) => /[\p{L}\p{N}]/u.test(first));
  if (words.length === 0) return '?';
  const first = words[0]!;
  const last = words.length > 1 ? words[words.length - 1]! : '';
  return (first + last).toUpperCase();
}

/** FNV-1a 32-bit hash. */
export function stringHash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** The abbreviation the UI shows for an object name ('' for none). */
export function shortSha(sha: string | undefined, length = 8): string {
  return sha ? sha.slice(0, length) : '';
}

/** True for the all-zero object ID Lanefold uses for the "uncommitted changes" row. */
export function isWorkingTreeSha(sha: string): boolean {
  return /^0+$/.test(sha);
}

/**
 * A count in four characters at most: as it is below a thousand, then in thousands ("1.4K",
 * "48K") and millions ("1.5M", "14M"), with a decimal only where it fits. A count that rounds
 * up to the next unit takes it (999,700 is "1M", not "1000K").
 */
export function compactCount(count: number): string {
  const short = (value: number, unit: string) => `${value.toFixed(1).replace(/\.0$/, '')}${unit}`;
  if (count < 1000) return String(count);
  if (count < 9950) return short(count / 1000, 'K');
  if (count < 999_500) return `${Math.round(count / 1000)}K`;
  if (count < 9_950_000) return short(count / 1_000_000, 'M');
  if (count < 999_500_000) return `${Math.round(count / 1_000_000)}M`;
  return short(count / 1_000_000_000, 'B');
}

const exact = new Intl.NumberFormat('en-US');
const counted = (count: number, one: string) => `${exact.format(count)} ${count === 1 ? one : `${one}s`}`;
/** A merge's counts are against its first parent, as its file list is. */
const AGAINST = ' (against the first parent)';

/** A commit's files in words, with exact counts: "9 files: 2 added, 6 changed, 1 removed". */
export function filesChangedText(stats: CommitStats, merge = false): string {
  const total = stats.added + stats.modified + stats.removed;
  if (total === 0) return `No files changed${merge ? AGAINST : ''}`;
  const parts = [
    stats.added > 0 ? `${exact.format(stats.added)} added` : '',
    stats.modified > 0 ? `${exact.format(stats.modified)} changed` : '',
    stats.removed > 0 ? `${exact.format(stats.removed)} removed` : '',
  ].filter(Boolean);
  return `${counted(total, 'file')}: ${parts.join(', ')}${merge ? AGAINST : ''}`;
}

/** A commit's lines in words, with exact counts: "184 lines added, 23 removed". */
export function linesChangedText(lines: CommitLineStats, merge = false): string {
  const parts = [
    lines.added > 0 ? `${counted(lines.added, 'line')} added` : '',
    lines.removed > 0
      ? `${lines.added > 0 ? exact.format(lines.removed) : counted(lines.removed, 'line')} removed`
      : '',
  ].filter(Boolean);
  const binary = lines.binary > 0 ? `${counted(lines.binary, 'binary file')} not counted` : '';
  const text = parts.length > 0 ? parts.join(', ') : binary ? '' : 'No lines changed';
  return `${[text, binary].filter(Boolean).join('; ')}${merge ? AGAINST : ''}`;
}
