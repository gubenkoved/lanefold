/** Formatting helpers for graph rows and details (dates, initials, hashes). */

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
