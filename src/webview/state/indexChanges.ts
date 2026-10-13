import { create } from 'zustand';

/*
 * Index changes (stage, unstage, lines of a file) this webview asked for and git is still making.
 * The file lists and counts catch up a moment after git is done (they are read again when it
 * reports the change): until then, what is staged is not known for sure, and a commit asked for
 * meanwhile waits for git rather than trusting the numbers on screen.
 */

const inFlight = new Map<string, Set<Promise<unknown>>>();

/** Index changes in flight, per repository. */
export const useIndexChanges = create<{ readonly pending: Readonly<Record<string, number>> }>(() => ({
  pending: {},
}));

function adjust(repoId: string, delta: number): void {
  useIndexChanges.setState((state) => ({
    pending: { ...state.pending, [repoId]: Math.max(0, (state.pending[repoId] ?? 0) + delta) },
  }));
}

/** Tracks an index change of a repository until git has made it (or failed to). */
export function changeIndex<T>(repoId: string, change: Promise<T>): Promise<T> {
  let changes = inFlight.get(repoId);
  if (!changes) inFlight.set(repoId, (changes = new Set()));
  changes.add(change);
  adjust(repoId, 1);
  const done = () => {
    changes.delete(change);
    adjust(repoId, -1);
  };
  change.then(done, done);
  return change;
}

/** Resolves once every index change asked for so far is made (or failed). */
export async function indexSettled(repoId: string): Promise<void> {
  await Promise.allSettled([...(inFlight.get(repoId) ?? [])]);
}
