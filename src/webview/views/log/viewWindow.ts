import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** The nearest ancestor that scrolls vertically (the details pane, a view's list…). */
export function scrollParent(element: HTMLElement): HTMLElement | undefined {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return undefined;
}

/** The part of an element in view of the pane it scrolls in, in its own coordinates (px). */
export interface ViewWindow {
  readonly top: number;
  readonly bottom: number;
}

/**
 * Follows which part of `ref`'s element is in view of the pane it scrolls in (its own
 * coordinates, from `inset` px into it), as the pane scrolls or resizes and whenever the
 * component renders (what is above it may have moved). Steps of `step` px keep scrolling from
 * rendering on every frame. While `enabled` is false it stays at its first guess.
 */
export function useViewWindow(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  inset = 0,
  step = 240,
): ViewWindow {
  const [view, setView] = useState<ViewWindow>({ top: 0, bottom: 1200 });
  const follow = useRef<() => void>(undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Looked up each time: which ancestor scrolls can change with the pane's size (the
      // uncommitted changes scroll with their commit box in a short pane).
      const scroller = scrollParent(element);
      const viewTop =
        (scroller?.getBoundingClientRect().top ?? 0) - element.getBoundingClientRect().top - inset;
      const height = scroller?.clientHeight ?? window.innerHeight;
      const top = Math.floor(viewTop / step) * step;
      const bottom = Math.ceil((viewTop + height) / step) * step;
      setView((current) => (current.top === top && current.bottom === bottom ? current : { top, bottom }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    follow.current = update;
    update();
    // Scroll events do not bubble: caught on their way down, from whichever ancestor scrolls.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const scroller = scrollParent(element);
    if (scroller) resize.observe(scroller);
    return () => {
      follow.current = undefined;
      document.removeEventListener('scroll', schedule, { capture: true });
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ref, enabled, inset, step]);
  // Whatever is above may have changed size: place the window again before painting.
  useLayoutEffect(() => follow.current?.());
  return view;
}
