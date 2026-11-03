import { Fragment, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { linkMessage, type Autolink, type CodeHost } from '../../../shared/codeHosts';
import type { RefInfo } from '../../../shared/models';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { initials, shortSha, stringHash } from '../../graph/format';
import type { LogModel } from '../../graph/logModel';
import { avatarColor } from '../../graph/palette';
import { laneColor } from '../../graph/repoColors';
import { useHost } from '../../hostContext';
import { openLink } from '../../state/codeHosts';
import { copyText } from '../../state/queries';
import { usePalette, useThemeKind } from '../../state/theme';
import styles from './parts.module.css';

const noop = () => () => undefined;

/** Re-renders when the model changes (rows streamed in, metadata loaded). */
export function useModelVersion(model: LogModel | undefined): number {
  return useSyncExternalStore(
    model ? (listener) => model.subscribe(listener) : noop,
    () => model?.version ?? 0,
  );
}

/** Re-renders only when the model's loading phase changes. */
export function useModelPhase(model: LogModel | undefined): LogModel['phase'] | undefined {
  return useSyncExternalStore(model ? (listener) => model.subscribe(listener) : noop, () => model?.phase);
}

export function Avatar({ name, email, size = 20 }: { name: string; email: string; size?: number }) {
  const kind = useThemeKind();
  return (
    <span
      className={styles.avatar}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: avatarColor(stringHash(email.toLowerCase()), kind),
      }}
      title={`${name} <${email}>`}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export async function copyWithToast(text: string, what: string): Promise<void> {
  if (await copyText(text))
    toast(`Copied ${what}`, { kind: 'success', detail: text.length > 80 ? undefined : text });
  else toast(`Could not copy ${what}`, { kind: 'error' });
}

/**
 * A commit message (or part of one) with its web addresses and issue references as links: they
 * read as the text around them until pointed at. `host`: whose issues `#12` names.
 */
export function MessageText({
  text,
  host,
  autolinks,
}: {
  text: string;
  host: CodeHost | undefined;
  autolinks: readonly Autolink[];
}) {
  const { rpc } = useHost();
  const parts = useMemo(() => linkMessage(text, host, autolinks), [text, host, autolinks]);
  return parts.map((part, index) =>
    part.url ? (
      <a
        key={index}
        className={styles.messageLink}
        href={part.url}
        title={part.url}
        onClick={(event) => {
          event.preventDefault();
          openLink(rpc, part.url!);
        }}
      >
        {part.text}
      </a>
    ) : (
      <Fragment key={index}>{part.text}</Fragment>
    ),
  );
}

/** A commit hash that copies itself on click. */
export function ShaChip({ sha, length = 8 }: { sha: string; length?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={styles.sha}
      title="Copy commit hash"
      onClick={() => {
        void copyText(sha).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} />
      {shortSha(sha, length)}
    </button>
  );
}

/** Lane color of a commit in the model (falls back to the muted foreground). */
export function useCommitColor(model: LogModel | undefined, sha: string): string | undefined {
  const palette = usePalette();
  if (!model) return undefined;
  const row = model.rowOf(sha);
  if (row < 0 || row >= model.layout.rowsDone) return undefined;
  return laneColor(palette, model.layout.nodeColor[row] ?? 0);
}

/** A clickable commit reference: lane-colored dot, short hash and subject. */
export function CommitChip({
  model,
  sha,
  subject,
  onClick,
  title,
}: {
  model: LogModel | undefined;
  sha: string;
  subject?: string;
  onClick?: () => void;
  title?: string;
}) {
  const color = useCommitColor(model, sha);
  const text = subject ?? model?.metaOf(sha)?.subject;
  return (
    <button
      type="button"
      className={styles.commitChip}
      onClick={onClick}
      disabled={!onClick}
      title={title ?? (text ? `${shortSha(sha)} ${text}` : sha)}
    >
      <span className={styles.dot} style={{ background: color ?? 'var(--lf-fg-muted)' }} />
      <span className={styles.chipSha}>{shortSha(sha)}</span>
      {text ? <span className={styles.chipSubject}>{text}</span> : null}
    </button>
  );
}

export function RefPills({ refs }: { refs: readonly RefInfo[] }) {
  if (refs.length === 0) return null;
  return (
    <span className={styles.refs}>
      {refs.map((ref) => (
        <span
          key={ref.name}
          className={[
            styles.ref,
            ref.kind === 'tag' ? styles.refTag : '',
            ref.isHead ? styles.refHead : '',
          ].join(' ')}
          title={ref.name}
        >
          <Icon
            name={
              ref.kind === 'tag'
                ? 'tag'
                : ref.kind === 'remote'
                  ? 'cloud'
                  : ref.isHead
                    ? 'check'
                    : 'git-branch'
            }
          />
          <span className={styles.refText}>{ref.short}</span>
        </span>
      ))}
    </span>
  );
}

/** A titled block in the details pane, with optional count and actions. */
export function Section({
  title,
  count,
  stats,
  actions,
  children,
}: {
  title: string;
  count?: number;
  stats?: { additions: number; deletions: number };
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>{title}</span>
        {count !== undefined ? <span className={styles.count}>{count}</span> : null}
        {stats && (stats.additions > 0 || stats.deletions > 0) ? (
          <span className={styles.stats}>
            <span className={styles.plus}>+{stats.additions.toLocaleString()}</span>
            <span className={styles.minus}>−{stats.deletions.toLocaleString()}</span>
          </span>
        ) : null}
        <span className={styles.flex} />
        {actions}
      </header>
      {children}
    </section>
  );
}

/** A small text button for section headers ("Open all changes"). */
export function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  primary,
  collapsible,
  title,
}: {
  icon?: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  /** Show only the icon when the section header is narrow. */
  collapsible?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={[styles.action, primary ? styles.primary : '', collapsible && icon ? styles.collapsible : '']
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
    >
      {icon ? <Icon name={icon} /> : null}
      <span>{label}</span>
    </button>
  );
}

export function Notice({ icon = 'info', children }: { icon?: string; children: ReactNode }) {
  return (
    <div className={styles.notice}>
      <Icon name={icon} />
      <span>{children}</span>
    </div>
  );
}

export function LoadingLine({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className={styles.loading}>
      <Icon name="loading" spin /> {text}
    </div>
  );
}

export function ErrorLine({ error }: { error: string }) {
  return (
    <div className={styles.error}>
      <Icon name="error" /> {error}
    </div>
  );
}
