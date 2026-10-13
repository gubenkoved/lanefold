import type { CSSProperties } from 'react';

export interface IconProps {
  /** Codicon name, e.g. "git-branch". */
  readonly name: string;
  readonly spin?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly title?: string;
}

export function Icon({ name, spin, className, style, title }: IconProps) {
  const classes = ['codicon', `codicon-${name}`, spin ? 'codicon-modifier-spin' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <span className={classes} style={style} title={title} aria-hidden={title ? undefined : true} />;
}
