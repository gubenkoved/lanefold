/**
 * Commits that were just rewritten (history edit): old hash → the commit it became. Graphs use
 * this on their next model switch to move rows from the old commits to the new ones (squashed
 * commits fold into their result) and to carry the selection over.
 */

interface Renames {
  readonly repoId: string;
  readonly map: ReadonlyMap<string, string>;
  readonly at: number;
}

/** A refresh normally lands well within this; later switches are unrelated. */
const VALID_MS = 15_000;

let latest: Renames | undefined;

export function noteRenames(repoId: string, map: Readonly<Record<string, string>>): void {
  latest = { repoId, map: new Map(Object.entries(map)), at: Date.now() };
}

export function recentRenames(repoId: string): ReadonlyMap<string, string> | undefined {
  if (!latest || latest.repoId !== repoId || Date.now() - latest.at > VALID_MS) return undefined;
  return latest.map;
}
