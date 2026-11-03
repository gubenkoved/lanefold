import { useEffect, useState } from 'react';
import type { CodeHost } from '../../shared/codeHosts';
import { errorText } from '../bridge/errorText';
import { toast } from '../components/Toast';
import { useHost } from '../hostContext';
import type { HostRpc } from '../bridge/host';
import { useRepoVersion } from './queries';
import { useApp } from './store';

/** The hosts last read per repository: menus read them as they open. */
const latest = new Map<string, readonly CodeHost[]>();

/** The repository's remotes on code hosts as last read; undefined before the first read. */
export function codeHostsNow(repoId: string): readonly CodeHost[] | undefined {
  return latest.get(repoId);
}

/**
 * The repository's remotes on code hosts, in the order links prefer them. Read again when its
 * configuration changes (a remote added, a URL set) or the link settings do.
 */
export function useCodeHosts(repoId: string): readonly CodeHost[] | undefined {
  const { rpc } = useHost();
  const config = useRepoVersion(rpc, repoId, ['config']);
  const settings = useApp((state) => state.settings.links.hosts);
  const [read, setRead] = useState<{ repoId: string; hosts: readonly CodeHost[] }>();
  useEffect(() => {
    let current = true;
    rpc.call('repo.codeHosts', { repoId }).then(
      (hosts) => {
        latest.set(repoId, hosts);
        if (current) setRead({ repoId, hosts });
      },
      // Links are an extra: without them the rest works as ever.
      () => {
        if (current) setRead({ repoId, hosts: latest.get(repoId) ?? [] });
      },
    );
    return () => {
      current = false;
    };
  }, [rpc, repoId, config, settings]);
  return read?.repoId === repoId ? read.hosts : latest.get(repoId);
}

/** Opens a web page in the browser (through the host: a webview opens none itself). */
export function openLink(rpc: HostRpc, url: string): void {
  rpc
    .call('host.openExternal', { url })
    .catch((error: unknown) => toast('Could not open the link', { kind: 'error', detail: errorText(error) }));
}
