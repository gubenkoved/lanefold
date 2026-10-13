/** How plans and results word things: short object names, counts and file lists. */

/** The 8-digit abbreviation of an object name ('' for none). */
export const short = (sha: string | undefined) => (sha ? sha.slice(0, 8) : '');

/** "1 file", "3 files"; `many` for the irregular ones ("2 branches"). */
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "a.txt", "a.txt and b.txt", "a.txt, b.txt and 4 more files". */
export function describePaths(paths: readonly string[]): string {
  if (paths.length <= 2) return paths.join(' and ');
  return `${paths.slice(0, 2).join(', ')} and ${plural(paths.length - 2, 'more file')}`;
}

/** The last part of a path ("src/a.ts" is "a.ts"). */
export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
