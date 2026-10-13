import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { useLayoutEffect, useRef, useState } from 'react';
import type { CommitDetails } from '../../../shared/models';
import { absoluteTime, isWorkingTreeSha, relativeLong, shortSha } from '../../graph/format';
import type { LogModel } from '../../graph/logModel';
import { useHost } from '../../hostContext';
import { fetchCommitDetails, useQuery } from '../../state/queries';
import { totals } from './FileList';
import { Avatar, RefPills } from './parts';
import styles from './HoverCard.module.css';

export interface HoverTarget {
  readonly row: number;
  readonly rect: DOMRect;
}

const BODY_LINES = 8;

/** Commit summary shown while the pointer rests on a graph row. */
export function HoverCard({
  repoId,
  model,
  target,
  repository,
}: {
  repoId: string;
  model: LogModel;
  target: HoverTarget;
  /** The commit's repository, named in a log of several. */
  repository?: { readonly name: string; readonly color: string };
}) {
  const host = useHost();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | undefined>();
  const sha = target.row < model.rowCount ? model.sha(target.row) : undefined;
  const meta = sha ? model.metaOf(sha) : undefined;
  const details = useQuery<CommitDetails>(sha && meta ? `${repoId}:${sha}` : undefined, () =>
    fetchCommitDetails(host.rpc, repoId, sha!),
  );

  useLayoutEffect(() => {
    if (!ref.current) return;
    const { rect } = target;
    const x = rect.left + Math.min(72, rect.width / 4);
    const reference = {
      getBoundingClientRect: () => ({
        x,
        y: rect.top,
        left: x,
        top: rect.top,
        right: x,
        bottom: rect.bottom,
        width: 0,
        height: rect.height,
      }),
    };
    void computePosition(reference, ref.current, {
      strategy: 'fixed',
      placement: 'bottom-start',
      middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    }).then(({ x: left, y: top }) => setPosition({ x: left, y: top }));
  }, [target, details.data]);

  if (!sha || !meta || isWorkingTreeSha(sha)) return null;
  const current = details.data?.sha === sha ? details.data : undefined;
  const bodyLines = current?.body.split('\n') ?? [];
  const body = bodyLines.slice(0, BODY_LINES).join('\n').trim();
  const refs = model.refsAt(target.row) ?? [];
  const stats = current ? totals(current.files) : undefined;

  return (
    <div
      ref={ref}
      className={styles.card}
      role="tooltip"
      style={{
        left: position?.x ?? -9999,
        top: position?.y ?? -9999,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {repository ? (
        <div className={styles.repository}>
          <span className={styles.repositoryDot} style={{ background: repository.color }} />
          {repository.name}
        </div>
      ) : null}
      <div className={styles.subject}>{meta.subject}</div>
      {body ? (
        <pre className={styles.body}>
          {body}
          {bodyLines.length > BODY_LINES ? '\n…' : ''}
        </pre>
      ) : null}
      <div className={styles.meta}>
        <Avatar name={meta.author} email={meta.authorEmail} size={18} />
        <span className={styles.author}>{meta.author}</span>
        <span className={styles.muted} title={absoluteTime(meta.authorTime)}>
          {relativeLong(meta.authorTime)}
        </span>
      </div>
      <div className={styles.footer}>
        <span className={styles.sha}>{shortSha(sha, 10)}</span>
        {stats ? (
          <span className={styles.muted}>
            {current!.files.length} file{current!.files.length === 1 ? '' : 's'}
            <span className={styles.plus}> +{stats.additions}</span>
            <span className={styles.minus}> −{stats.deletions}</span>
          </span>
        ) : null}
        {meta.parents.length > 1 ? <span className={styles.muted}>merge</span> : null}
      </div>
      {refs.length > 0 ? <RefPills refs={refs} /> : null}
    </div>
  );
}
