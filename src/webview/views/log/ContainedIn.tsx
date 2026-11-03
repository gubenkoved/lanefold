import { useState } from 'react';
import type { RefInfo, RefsSnapshot } from '../../../shared/models';
import { Icon } from '../../components/Icon';
import type { LogModel } from '../../graph/logModel';
import { useHost } from '../../hostContext';
import { useQuery, useRepoVersion } from '../../state/queries';
import { orderBranches } from './viewRefs';
import styles from './ContainedIn.module.css';

/** Pills listed per kind before the rest fold into "N more". */
const FIRST = 6;
/** How long (ms) a commit stays selected before git is asked: stepping through commits asks nothing. */
const SETTLE_MS = 150;
const CACHE_SIZE = 200;

const REF_ICONS = { head: 'check', branch: 'git-branch', remote: 'cloud', tag: 'tag' } as const;

/** Answers per commit, valid while the refs they were read with are the view's refs. */
const cache = new Map<string, { readonly refs: RefsSnapshot; readonly containing: readonly RefInfo[] }>();

function remember(key: string, refs: RefsSnapshot, containing: readonly RefInfo[]): void {
  cache.delete(key);
  cache.set(key, { refs, containing });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
}

function settle(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, SETTLE_MS);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function Pills({
  label,
  refs,
  onReveal,
  firstTitle,
}: {
  label: string;
  refs: readonly RefInfo[];
  onReveal: (sha: string) => void;
  /** The first pill's tooltip, when it means something more than its name. */
  firstTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? refs : refs.slice(0, FIRST);
  return (
    <>
      <dt className={styles.label}>
        {label}
        <span className={styles.count}>{refs.length.toLocaleString()}</span>
      </dt>
      <dd className={styles.refs}>
        {shown.map((ref, index) => (
          <button
            key={ref.name}
            type="button"
            className={styles.ref}
            data-kind={ref.isHead ? 'head' : ref.kind}
            title={index === 0 && firstTitle ? `${ref.short}: ${firstTitle}` : `Go to ${ref.short}`}
            aria-label={`Go to ${ref.short}`}
            onClick={() => onReveal(ref.target)}
          >
            <Icon name={REF_ICONS[ref.isHead ? 'head' : ref.kind]} />
            <span className={styles.refText}>{ref.short}</span>
          </button>
        ))}
        {refs.length > FIRST ? (
          <button type="button" className={styles.more} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Fewer' : `${(refs.length - FIRST).toLocaleString()} more`}
          </button>
        ) : null}
      </dd>
    </>
  );
}

/**
 * The branches, remote branches and tags whose history holds a commit: where a change has got
 * to (merged into the trunk yet? in which release first?). Choosing one goes to its commit.
 */
export function ContainedIn({
  repoId,
  model,
  sha,
  onReveal,
}: {
  repoId: string;
  model: LogModel;
  sha: string;
  onReveal: (sha: string) => void;
}) {
  const host = useHost();
  const version = useRepoVersion(host.rpc, repoId);
  const key = `${repoId}\0${sha}`;
  const snapshot = model.refs;
  const known = cache.get(key);
  const cached = known?.refs === snapshot ? known.containing : undefined;
  const query = useQuery(cached ? undefined : `${key}\0${version}`, async (signal) => {
    await settle(signal);
    const containing = await host.rpc.call('commit.containedIn', { repoId, sha }, { signal });
    remember(key, snapshot, containing);
    return { sha, containing };
  });
  const containing = cached ?? (query.data?.sha === sha ? query.data.containing : undefined);

  if (!containing) {
    return (
      <p className={styles.quiet}>
        {query.error ? (
          <>
            <Icon name="error" /> The branches that contain it could not be listed: {query.error}
          </>
        ) : (
          <>
            <Icon name="loading" spin /> Finding the branches that contain it…
          </>
        )}
      </p>
    );
  }
  const branches = orderBranches(containing, snapshot.trunk);
  // Oldest first (git sorts them by date): the first is the first release to have the commit.
  const tags = containing.filter((ref) => ref.kind === 'tag');
  if (branches.length === 0 && tags.length === 0)
    return (
      <p className={styles.quiet}>
        <Icon name="info" /> No branch or tag contains this commit.
      </p>
    );
  return (
    <dl className={styles.root} aria-label="Branches and tags that contain this commit">
      {branches.length > 0 ? <Pills label="Branches" refs={branches} onReveal={onReveal} /> : null}
      {tags.length > 0 ? (
        <Pills
          label="Tags"
          refs={tags}
          onReveal={onReveal}
          firstTitle="the oldest tag that contains this commit"
        />
      ) : null}
    </dl>
  );
}
