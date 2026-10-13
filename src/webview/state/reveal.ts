import { create } from 'zustand';

/** A commit the host asked to show (blame hover, status bar), until a log view takes it. */
interface RevealStore {
  readonly request?: {
    readonly repoId: string;
    readonly sha: string;
    readonly id: number;
    /** When it was asked for (ms since epoch). */
    readonly time: number;
  };
}

export const useReveal = create<RevealStore>(() => ({}));

let counter = 0;

export function requestReveal(repoId: string, sha: string): void {
  useReveal.setState({ request: { repoId, sha, id: ++counter, time: Date.now() } });
}

/** Marks a request as handled (only if it is still the current one). */
export function takeReveal(id: number): void {
  if (useReveal.getState().request?.id === id) useReveal.setState({ request: undefined });
}
