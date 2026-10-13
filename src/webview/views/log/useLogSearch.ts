import { useEffect, useMemo, useState } from 'react';
import { parseSearch, type ViewConfig } from '../../../shared/models';
import { LogModel } from '../../graph/logModel';
import { useHost } from '../../hostContext';
import { useQuery } from '../../state/queries';
import { useModelPhase } from './parts';

export interface SearchMatches {
  readonly shas: ReadonlySet<string>;
  /** More commits match than were returned. */
  readonly truncated: boolean;
}

const SEARCH_LIMIT = 5000;
const DEBOUNCE_MS = 220;

/**
 * The log's search box: parses operators, asks git for message/author/path/date matches and
 * resolves hashes locally against the loaded history. Results refresh with the history.
 * `repoIds`: the repositories searched (a log of several finds the matches of every one).
 * `initialText`: the search the view opens with (it runs as soon as the history is loaded).
 */
export function useLogSearch(
  repoId: string,
  view: ViewConfig,
  source: LogModel | undefined,
  repoIds: readonly string[] = [repoId],
  initialText = '',
) {
  const host = useHost();
  const [text, setText] = useState(initialText);
  const [debounced, setDebounced] = useState(() => initialText.trim());
  const phase = useModelPhase(source);

  useEffect(() => {
    const trimmed = text.trim();
    const timer = setTimeout(() => setDebounced(trimmed), trimmed ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [text]);

  const ready = !!source && phase === 'ready';
  const key = debounced && ready ? `${source.id}\0${debounced}` : undefined;
  const result = useQuery<SearchMatches>(key, async (signal) => {
    const { hash, ...query } = parseSearch(debounced);
    let shas: Set<string> | undefined;
    let truncated = false;
    const needsGit = !!(
      query.text ||
      query.author ||
      query.message ||
      query.paths ||
      query.after ||
      query.before
    );
    if (needsGit) {
      const settled = await Promise.allSettled(
        repoIds.map((id) =>
          host.rpc.call('log.search', { repoId: id, view, query, limit: SEARCH_LIMIT }, { signal }),
        ),
      );
      // A repository that cannot be searched does not hide the others' matches.
      const found = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      if (found.length === 0 && settled[0]?.status === 'rejected') throw settled[0].reason;
      shas = new Set(found.flatMap((result) => result.shas));
      truncated = found.some((result) => result.truncated);
    }
    // "#abc123" narrows to that commit; plain text that looks like a hash also finds it.
    const hashLike = hash ?? (query.text && /^[0-9a-f]{7,64}$/i.test(query.text) ? query.text : undefined);
    if (hashLike && source) {
      const byHash = source.rowsWithPrefix(hashLike, 200).map((row) => source.sha(row));
      if (hash) shas = shas ? new Set(byHash.filter((sha) => shas!.has(sha))) : new Set(byHash);
      else {
        shas ??= new Set();
        for (const sha of byHash) shas.add(sha);
      }
    }
    // A branch or tag name finds the commit it points at ("main", "v1.0").
    const refName = query.text?.trim();
    if (refName && source) {
      for (const ref of source.refs.refs) {
        if (ref.short === refName || ref.short.endsWith(`/${refName}`)) (shas ??= new Set()).add(ref.target);
      }
    }
    return { shas: shas ?? new Set(), truncated };
  });

  const active = debounced !== '' && text.trim() !== '';
  // While the same query runs again (the history reloaded), its last matches stay shown.
  const [last, setLast] = useState<{ query: string; matches: SearchMatches } | undefined>(undefined);
  const fresh = active && !result.loading ? result.data : undefined;
  if (fresh && (last?.matches !== fresh || last.query !== debounced))
    setLast({ query: debounced, matches: fresh });
  const kept = active && last?.query === debounced ? last.matches : undefined;
  return {
    text,
    setText,
    /** The query the matches are for (debounced). */
    query: active ? debounced : '',
    /** The query is being typed or run. */
    pending: text.trim() !== debounced || (active && result.loading) || (active && !ready),
    matches: fresh ?? kept,
    error: active ? result.error : undefined,
  };
}

/** A model showing only the matches (graph kept connected), or undefined when not filtering. */
export function useFilteredModel(
  source: LogModel | undefined,
  matches: SearchMatches | undefined,
  enabled: boolean,
): LogModel | undefined {
  const phase = useModelPhase(source);
  const filtered = useMemo(() => {
    if (!enabled || !source || !matches || phase !== 'ready') return undefined;
    const keep = new Uint8Array(source.topology.rowCount);
    for (const row of source.rowsOf(matches.shas).values()) keep[row] = 1;
    return LogModel.derive(source, keep);
  }, [enabled, source, matches, phase]);
  // While a reload streams in, the last filtered graph stays up rather than the whole history.
  const [kept, setKept] = useState<LogModel | undefined>(undefined);
  if (filtered && filtered !== kept) setKept(filtered);
  else if (!enabled && kept) setKept(undefined);
  // A filtered model is disposed once it is no longer the one kept (or on unmount).
  useEffect(() => () => kept?.dispose(), [kept]);
  if (!enabled) return undefined;
  return filtered ?? (matches ? kept : undefined);
}
