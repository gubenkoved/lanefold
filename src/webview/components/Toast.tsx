import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Icon } from './Icon';
import styles from './Toast.module.css';

export type ToastKind = 'info' | 'success' | 'error';

interface ToastEntry {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
  readonly detail?: string;
  readonly action?: { readonly label: string; readonly run: () => void };
  /** A second, quieter action before the main one (Undo, next to a suggested next step). */
  readonly secondary?: { readonly label: string; readonly run: () => void };
  /** A newer toast of the same group replaces this one (operation results: only the latest offers Undo). */
  readonly group?: string;
}

interface ToastState {
  readonly toasts: readonly ToastEntry[];
}

const useToasts = create<ToastState>(() => ({ toasts: [] }));
let nextId = 1;

/** Each toast's time left; all of them wait while the pointer or focus is on a toast. */
const timers = new Map<
  number,
  { handle?: ReturnType<typeof setTimeout>; remaining: number; started: number }
>();
let paused = false;

function schedule(id: number): void {
  const timer = timers.get(id);
  if (!timer) return;
  timer.started = Date.now();
  timer.handle = setTimeout(() => dismiss(id), timer.remaining);
}

function pause(): void {
  if (paused) return;
  paused = true;
  for (const timer of timers.values()) {
    clearTimeout(timer.handle);
    timer.remaining -= Date.now() - timer.started;
  }
}

function resume(): void {
  if (!paused) return;
  paused = false;
  for (const [id, timer] of timers) {
    // A moment to read it again after looking away.
    timer.remaining = Math.max(timer.remaining, 1500);
    schedule(id);
  }
}

/** Shows a transient message at the bottom of the view. */
export function toast(
  message: string,
  options: {
    kind?: ToastKind;
    detail?: string;
    action?: ToastEntry['action'];
    secondary?: ToastEntry['secondary'];
    durationMs?: number;
    group?: string;
  } = {},
): void {
  const id = nextId++;
  const entry: ToastEntry = {
    id,
    kind: options.kind ?? 'info',
    message,
    detail: options.detail,
    action: options.action,
    secondary: options.secondary,
    group: options.group,
  };
  // At most three at a time; the newest replaces the oldest (and any older one of its group).
  useToasts.setState(({ toasts }) => ({
    toasts: [...toasts.filter((t) => !entry.group || t.group !== entry.group).slice(-2), entry],
  }));
  const duration = options.durationMs ?? (entry.kind === 'error' ? 7000 : 2600);
  timers.set(id, { remaining: duration, started: Date.now() });
  if (!paused) schedule(id);
}

function dismiss(id: number): void {
  clearTimeout(timers.get(id)?.handle);
  timers.delete(id);
  // The toast under the pointer may be the one going away (its action was clicked).
  if (timers.size === 0) paused = false;
  useToasts.setState(({ toasts }) => ({ toasts: toasts.filter((t) => t.id !== id) }));
}

const ICONS: Record<ToastKind, string> = { info: 'info', success: 'pass', error: 'error' };

/**
 * Bars at the bottom of a view that toasts stay above, so their actions and notices stay in
 * reach: the commit box (repeated commits), the history editor's and the review sheet's footers.
 */
const KEEP_CLEAR = 'form[aria-label="Commit"], footer, [data-keep-clear]';
/** Toasts' distance from the window's bottom edge, and from a bar they stay above (px). */
const MARGIN = 12;
const GAP = 8;

/**
 * How far above the window's bottom edge the toasts go: clear of the bars below them, unless a
 * bar reaches so high (most of the window) that the toasts would hide the view instead.
 */
function bottomOffset(host: HTMLElement): number {
  const { left, right } = host.getBoundingClientRect();
  const height = window.innerHeight;
  let offset = MARGIN;
  for (const bar of document.querySelectorAll(KEEP_CLEAR)) {
    const rect = bar.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue; // hidden (a tab in the background)
    if (rect.right <= left || rect.left >= right) continue; // beside the toasts
    if (rect.bottom < height - 2 * MARGIN || rect.top < height * 0.45) continue;
    offset = Math.max(offset, height - rect.top + GAP);
  }
  return offset;
}

/** How often the toasts' place is checked while some show (a bar may appear under them). */
const PLACE_EVERY_MS = 400;

function ToastItem({ entry }: { entry: ToastEntry }) {
  // A toast on its way out is neither clickable nor announced.
  const present = useIsPresent();
  return (
    <motion.div
      layout
      inert={!present}
      aria-hidden={!present || undefined}
      // Errors are announced right away; the others when the screen reader is idle (the host).
      role={entry.kind === 'error' ? 'alert' : undefined}
      className={[styles.toast, styles[entry.kind]].join(' ')}
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 520, damping: 38 }}
    >
      <Icon name={ICONS[entry.kind]} className={styles.icon} />
      <div className={styles.text}>
        {/* Two lines at most; all of it in the tooltip. */}
        <span className={styles.message} title={entry.message.length > 60 ? entry.message : undefined}>
          {entry.message}
        </span>
        {entry.detail ? (
          // Three lines hold ~140 characters in a narrow view: past that, all of it in the tooltip.
          <span className={styles.detail} title={entry.detail.length > 140 ? entry.detail : undefined}>
            {entry.detail}
          </span>
        ) : null}
      </div>
      {entry.secondary ? (
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            dismiss(entry.id);
            entry.secondary!.run();
          }}
        >
          {entry.secondary.label}
        </button>
      ) : null}
      {entry.action ? (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            dismiss(entry.id);
            entry.action!.run();
          }}
        >
          {entry.action.label}
        </button>
      ) : null}
      <button type="button" className={styles.close} aria-label="Dismiss" onClick={() => dismiss(entry.id)}>
        <Icon name="close" />
      </button>
    </motion.div>
  );
}

/** Renders active toasts. Mount once at the app root. */
export function ToastHost() {
  const toasts = useToasts((state) => state.toasts);
  const hostRef = useRef<HTMLDivElement>(null);
  const [bottom, setBottom] = useState(MARGIN);
  const showing = toasts.length > 0;

  // Placed when one appears, and kept in place while they show.
  useLayoutEffect(() => {
    if (showing && hostRef.current) setBottom(bottomOffset(hostRef.current));
  }, [toasts, showing]);
  useEffect(() => {
    if (!showing) return;
    const place = () => hostRef.current && setBottom(bottomOffset(hostRef.current));
    const timer = setInterval(place, PLACE_EVERY_MS);
    window.addEventListener('resize', place);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', place);
    };
  }, [showing]);

  const settle = (host: HTMLElement) => {
    if (!host.matches(':hover') && !host.contains(document.activeElement)) resume();
  };
  return (
    <div
      ref={hostRef}
      className={styles.host}
      style={{ bottom }}
      role="status"
      aria-live="polite"
      onPointerEnter={pause}
      onPointerLeave={(event) => settle(event.currentTarget)}
      onFocus={pause}
      onBlur={(event) => {
        const host = event.currentTarget;
        // Focus moving between a toast's buttons stays inside.
        if (!host.contains(event.relatedTarget as Node | null)) setTimeout(() => settle(host));
      }}
    >
      <AnimatePresence initial={false}>
        {toasts.map((entry) => (
          <ToastItem key={entry.id} entry={entry} />
        ))}
      </AnimatePresence>
    </div>
  );
}
