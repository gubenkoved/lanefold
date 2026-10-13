import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './EmptyState.module.css';

/** The Lanefold motif: branch lanes rising and merging like a landscape. */
export function LandscapeArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 64" fill="none" aria-hidden="true">
      <path
        d="M8 56 C 30 56, 34 22, 60 22 S 90 56, 112 56"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M8 56 C 24 56, 26 36, 42 36 S 58 56, 74 56"
        stroke="var(--lf-syn-revision)"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.8"
      />
      <path
        d="M46 56 C 62 56, 66 30, 84 30 S 100 56, 112 56"
        stroke="var(--lf-syn-subcommand)"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.8"
      />
      <line x1="4" y1="56" x2="116" y2="56" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="60" cy="22" r="4" fill="var(--lf-bg)" stroke="currentColor" strokeWidth="2" />
      <circle cx="42" cy="36" r="3.5" fill="var(--lf-syn-revision)" />
      <circle cx="84" cy="30" r="3.5" fill="var(--lf-syn-subcommand)" />
      <circle cx="8" cy="56" r="3.5" fill="currentColor" />
      <circle cx="112" cy="56" r="3.5" fill="currentColor" />
    </svg>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: ReactNode;
  /** Technical detail under the description (an error message), shown small and selectable. */
  readonly detail?: string;
  /** A codicon; omit to show the landscape illustration. */
  readonly icon?: string;
  readonly actions?: ReactNode;
  readonly compact?: boolean;
}

export function EmptyState({ title, description, detail, icon, actions, compact }: EmptyStateProps) {
  return (
    <div className={[styles.root, compact ? styles.compact : ''].join(' ')}>
      {icon ? <Icon name={icon} className={styles.icon} /> : <LandscapeArt className={styles.art} />}
      <h2 className={styles.title}>{title}</h2>
      {description ? <p className={styles.description}>{description}</p> : null}
      {detail ? <p className={styles.detail}>{detail}</p> : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
