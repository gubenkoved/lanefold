import { useRef, type KeyboardEvent } from 'react';
import styles from './Segmented.module.css';

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** A tooltip (what the choice means, the git command behind it). */
  readonly title?: string;
}

/** A toolbar's segments are small, a sheet's large. */
export type SegmentSize = 'small' | 'medium' | 'large';

const SIZES: Record<SegmentSize, string | undefined> = {
  small: styles.small,
  medium: undefined,
  large: styles.large,
};

/**
 * The classes of a segmented control's group, its buttons the segments: every toggle looks the
 * same, the hand-made ones (a toggle-button group, a group with icons) too. `className` adds the
 * group's place in a layout.
 */
export function segmentedClass(size: SegmentSize = 'medium', className?: string): string {
  return [styles.group, SIZES[size], className].filter(Boolean).join(' ');
}

/**
 * One choice of a few, as a radio group: one tab stop, arrow keys move the choice (and focus
 * with it), as radio groups do. `size` sets the segments' height, `className` adds the group's
 * place in a layout; `labelledBy` names it by a visible label instead of `label`.
 */
export function Segmented<T extends string>({
  label,
  labelledBy,
  describedBy,
  value,
  options,
  onChange,
  size,
  className,
  disabled,
}: {
  label: string;
  labelledBy?: string;
  describedBy?: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  size?: SegmentSize;
  className?: string;
  disabled?: boolean;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const current = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else return;
    event.preventDefault();
    onChange(options[next]!.value);
    buttons.current[next]?.focus();
  };
  return (
    <div
      className={segmentedClass(size, className)}
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-disabled={disabled || undefined}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={index === current}
          tabIndex={index === current ? 0 : -1}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
