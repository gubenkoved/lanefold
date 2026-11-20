import { create } from 'zustand';

/**
 * How much of a commit to bring into view: its row in the graph, its details too (the details
 * pane opens if it is closed), or, for the uncommitted changes, the commit box in those details
 * with the cursor in it.
 */
export type RevealShow = 'row' | 'details' | 'commitBox';

/** A commit the host asked to show (blame hover, status bar), until a log view takes it. */
interface RevealStore {
  readonly request?: {
    readonly repoId: string;
    readonly sha: string;
    readonly show: RevealShow;
    readonly id: number;
    /** When it was asked for (ms since epoch). */
    readonly time: number;
  };
}

export const useReveal = create<RevealStore>(() => ({}));

let counter = 0;

export function requestReveal(repoId: string, sha: string, show: RevealShow = 'row'): void {
  useReveal.setState({ request: { repoId, sha, show, id: ++counter, time: Date.now() } });
}

/** Marks a request as handled (only if it is still the current one). */
export function takeReveal(id: number): void {
  if (useReveal.getState().request?.id === id) useReveal.setState({ request: undefined });
}
