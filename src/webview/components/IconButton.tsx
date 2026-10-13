import type { MouseEvent } from 'react';
import { Icon } from './Icon';
import styles from './IconButton.module.css';

export interface IconButtonProps {
  readonly icon: string;
  /** Accessible label; also the tooltip. */
  readonly label: string;
  readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly small?: boolean;
  readonly spin?: boolean;
  readonly className?: string;
}

export function IconButton({
  icon,
  label,
  onClick,
  pressed,
  disabled,
  small,
  spin,
  className,
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={[styles.button, small ? styles.small : '', className ?? ''].join(' ')}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} spin={spin} />
    </button>
  );
}
