import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CommitDetails, RepoChangeKind } from '../../shared/models';
import { errorText } from '../bridge/errorText';
import type { HostRpc } from '../bridge/host';
import { REFRESH_EVENT } from './store';

export interface QueryState<T> {
  readonly data?: T;
  readonly error?: string;
  /** A request is in flight (`data` may still hold the previous result). */
  readonly loading: boolean;
}

/**
 * Runs `fetcher` whenever `key` changes, cancelling the previous request. Keeps returning the
 * previous data while the next request runs (consumers fade it), which avoids flicker when
 * stepping through commits with the keyboard. `key` undefined disables the query.
 */
export function useQuery<T>(
  key: string | undefined,
  fetcher: (signal: AbortSignal) => Promise<T>,
): QueryState<T> {
  const [state, setState] = useState<{ key?: string; data?: T; error?: string }>({});
  const fetcherRef = useRef(fetcher);
  useLayoutEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (key === undefined) return;
    const controller = new AbortController();
    fetcherRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key, data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ key, error: errorText(error) });
      },
    );
    return () => controller.abort();
  }, [key]);

  if (key === undefined) return { loading: false };
  const fresh = state.key === key;
  return { data: state.data, error: fresh ? state.error : undefined, loading: !fresh };
}

const DETAILS_CACHE_SIZE = 300;
const detailsCache = new Map<string, Promise<CommitDetails>>();

/** Commit details (message body and changed files), cached: commits are immutable. */
export function fetchCommitDetails(rpc: HostRpc, repoId: string, sha: string): Promise<CommitDetails> {
  const key = `${repoId}\0${sha}`;
  const cached = detailsCache.get(key);
  if (cached) {
    // Refresh the LRU position.
    detailsCache.delete(key);
    detailsCache.set(key, cached);
    return cached;
  }
  const promise = rpc.call('commit.details', { repoId, sha });
  detailsCache.set(key, promise);
  promise.catch(() => detailsCache.delete(key));
  while (detailsCache.size > DETAILS_CACHE_SIZE) {
    detailsCache.delete(detailsCache.keys().next().value as string);
  }
  return promise;
}

/** Copies text and reports success (clipboard access can be denied in some hosts). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Increments when the repository's refs or HEAD move, or a refresh is requested. */
export function useRepoVersion(
  rpc: HostRpc,
  repoId: string,
  watched: readonly RepoChangeKind[] = ['refs', 'head'],
): number {
  const [version, setVersion] = useState(0);
  const key = watched.join(',');
  useEffect(() => {
    const kindsWatched = new Set(key.split(','));
    const bump = () => setVersion((value) => value + 1);
    const off = rpc.on('repo.changed', ({ repoId: changed, kinds }) => {
      if (changed === repoId && kinds.some((kind) => kindsWatched.has(kind))) bump();
    });
    window.addEventListener(REFRESH_EVENT, bump);
    return () => {
      off();
      window.removeEventListener(REFRESH_EVENT, bump);
    };
  }, [rpc, repoId, key]);
  return version;
}
