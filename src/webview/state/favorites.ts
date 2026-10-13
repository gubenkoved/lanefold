import { useEffect } from 'react';
import { create } from 'zustand';
import { hostRpc } from './store';

/** Favorite refs (full names) per repository, persisted by the host. */
const useFavorites = create<{ byRepo: Readonly<Record<string, readonly string[]>> }>(() => ({
  byRepo: {},
}));
const loading = new Set<string>();

function key(repoId: string): string {
  return `favorites:${repoId}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The repository's favorite refs (loaded on first use). */
export function useFavoriteRefs(repoId: string): readonly string[] {
  const favorites = useFavorites((state) => state.byRepo[repoId]);
  useEffect(() => {
    if (favorites || loading.has(repoId)) return;
    loading.add(repoId);
    hostRpc()
      .call('storage.get', { key: key(repoId) })
      .then((stored) => {
        const list = isStringArray(stored) ? stored : [];
        useFavorites.setState((state) => ({ byRepo: { ...state.byRepo, [repoId]: list } }));
      })
      .catch(() => undefined)
      .finally(() => loading.delete(repoId));
  }, [repoId, favorites]);
  return favorites ?? [];
}

export function toggleFavorite(repoId: string, ref: string): void {
  const current = useFavorites.getState().byRepo[repoId] ?? [];
  const next = current.includes(ref) ? current.filter((name) => name !== ref) : [...current, ref];
  useFavorites.setState((state) => ({ byRepo: { ...state.byRepo, [repoId]: next } }));
  void hostRpc()
    .call('storage.set', { key: key(repoId), value: next })
    .catch(() => undefined);
}
