import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ViewConfig } from '../../../shared/models';
import type { LogModel } from '../../graph/logModel';
import { ReposLogModel, type RepoLabel } from '../../graph/reposLogModel';
import { useHost } from '../../hostContext';
import { REFRESH_EVENT } from '../../state/store';
import { LogLoader, type LoadedModel } from '../log/useLogModel';

/**
 * The model of the log of several repositories, kept current like a repository's own: it
 * reloads (in place, animated) when any of them gets commits or moves a ref or HEAD. Its rows
 * are commits only, so edits to files do not concern it.
 */
export function useReposLogModel(
  repoIds: readonly string[],
  view: ViewConfig,
  active: boolean,
  topRow: () => number,
  label: (repoId: string) => RepoLabel,
): LoadedModel | undefined {
  const host = useHost();
  const [loaded, setLoaded] = useState<LoadedModel>();
  const loaderRef = useRef<LogLoader | undefined>(undefined);
  const handoverRef = useRef<LogModel | undefined>(undefined);
  const topRowRef = useRef(topRow);
  const activeRef = useRef(active);
  const labelRef = useRef(label);
  useLayoutEffect(() => {
    topRowRef.current = topRow;
    activeRef.current = active;
    labelRef.current = label;
  });
  const key = JSON.stringify({ repoIds, view });

  useEffect(() => {
    const { repoIds: ids, view: config } = JSON.parse(key) as { repoIds: string[]; view: ViewConfig };
    const loader = new LogLoader(
      host.rpc,
      ids[0] ?? '',
      config,
      (next) => setLoaded(next),
      () => topRowRef.current(),
      () => new ReposLogModel(host.rpc, ids, config, (id) => labelRef.current(id)),
    );
    loader.active = activeRef.current;
    loaderRef.current = loader;
    const previous = handoverRef.current;
    handoverRef.current = undefined;
    loader.start(previous);

    const watched = new Set(ids);
    const offChange = host.rpc.on('repo.changed', ({ repoId, kinds }) => {
      const history = kinds.filter((kind) => kind === 'head' || kind === 'refs');
      if (watched.has(repoId) && history.length > 0) loader.onRepoChanged(history);
    });
    const onRefresh = () => loader.refresh();
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => {
      offChange();
      window.removeEventListener(REFRESH_EVENT, onRefresh);
      // Keep the model on screen for the next one (it animates into it).
      handoverRef.current = loader.release();
      loaderRef.current = undefined;
    };
  }, [host, key]);

  useEffect(() => loaderRef.current?.setActive(active), [active]);

  // On unmount nothing takes over the last model.
  useEffect(
    () => () => {
      handoverRef.current?.dispose();
      handoverRef.current = undefined;
    },
    [],
  );

  return loaded;
}
