import type { RemoteInfo } from '../../shared/models';
import { useHost } from '../hostContext';
import { runOperation, type RunOptions } from './operations';
import { useQuery, useRepoVersion } from './queries';

/** The repository's remotes (fetched or not), reloaded when refs or git's settings change. */
export function useRemotes(repoId: string | undefined): readonly RemoteInfo[] | undefined {
  const host = useHost();
  const version = useRepoVersion(host.rpc, repoId ?? '', ['refs', 'config']);
  return useQuery(repoId ? `${repoId}:remotes:${version}` : undefined, () =>
    host.rpc.call('repo.remotes', { repoId: repoId! }),
  ).data;
}

/**
 * Starts adding a remote: a form in the review sheet, fetching it right away by default. While
 * the repository has no "origin", that is the name suggested.
 */
export function addRemote(existing: readonly RemoteInfo[] = [], options: RunOptions = {}): void {
  const name = existing.some((remote) => remote.name === 'origin') ? '' : 'origin';
  void runOperation({ kind: 'addRemote', name, url: '', fetch: true }, options);
}
