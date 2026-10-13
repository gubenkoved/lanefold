import { useCallback, useState, type KeyboardEvent, type PointerEvent } from 'react';
import styles from './Splitter.module.css';

/** A size remembered in local storage (per view kind, not per tab). */
export function usePersistentSize(key: string, initial: number): [number, (size: number) => void] {
  const [size, setSize] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(`lanefold.size.${key}`));
      return Number.isFinite(stored) && stored > 0 ? stored : initial;
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (next: number) => {
      setSize(next);
      try {
        localStorage.setItem(`lanefold.size.${key}`, String(Math.round(next)));
      } catch {
        // Not persisted; fine.
      }
    },
    [key],
  );
  return [size, update];
}

export interface SplitterProps {
  /** 'vertical' splits side by side (a vertical bar); 'horizontal' stacks panes. */
  readonly orientation: 'vertical' | 'horizontal';
  /** Size of the pane after the splitter (right or bottom). */
  readonly size: number;
  readonly min: number;
  readonly max: number;
  readonly onResize: (size: number) => void;
  readonly defaultSize: number;
  readonly label: string;
  /** The pane is before the splitter (left or top) instead of after it. */
  readonly before?: boolean;
}

/** Draggable, keyboard-accessible divider between a view and its side pane. */
export function Splitter({
  orientation,
  size,
  min,
  max,
  onResize,
  defaultSize,
  label,
  before,
}: SplitterProps) {
  const sign = before ? -1 : 1;
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.min(max, Math.max(min, value));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setDragging(true);
    const start = orientation === 'vertical' ? event.clientX : event.clientY;
    const startSize = size;
    const move = (e: globalThis.PointerEvent) => {
      const position = orientation === 'vertical' ? e.clientX : e.clientY;
      onResize(clamp(startSize - sign * (position - start)));
    };
    const up = () => {
      setDragging(false);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const [back, forward] =
      orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const grow = before ? forward : back;
    const shrink = before ? back : forward;
    if (event.key === grow) onResize(clamp(size + step));
    else if (event.key === shrink) onResize(clamp(size - step));
    else if (event.key === 'Home') onResize(max);
    else if (event.key === 'End') onResize(min);
    else return;
    event.preventDefault();
  };

  return (
    <div
      className={styles.splitter}
      data-orientation={orientation}
      data-dragging={dragging}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize(clamp(defaultSize))}
      onKeyDown={onKeyDown}
    />
  );
}
