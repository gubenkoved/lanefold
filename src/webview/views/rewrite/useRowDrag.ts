import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

/**
 * Where dragged commits go: between two rows (`index` in the list, newest first: 0 is above the
 * first row), or onto a commit, folding them into it.
 */
export type DropTarget =
  | { readonly kind: 'move'; readonly index: number }
  | { readonly kind: 'fold'; readonly sha: string; readonly action: 'squash' | 'fixup' };

/** A drag in progress: what moves, where the pointer is, and what a drop would do. */
export interface RowDrag {
  /** The dragged commits, newest first. */
  readonly shas: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly target?: DropTarget;
}

export interface RowDragOptions {
  /** The scrolling container of the rows (rows carry `data-sha`). */
  readonly scrollRef: RefObject<HTMLElement | null>;
  /** The list's order, newest first. */
  readonly order: readonly string[];
  /** Whether commits can be folded into this one (not into a dropped commit). */
  readonly canFold: (sha: string) => boolean;
  readonly onDrop: (shas: readonly string[], target: DropTarget) => void;
}

/** Movement (px) before a press on a row becomes a drag. */
const THRESHOLD = 4;
/** Distance (px) from the list's top or bottom edge within which a drag scrolls it. */
const EDGE = 36;
/** The middle part of a row (fraction of its height) that folds; above and below it moves. */
const FOLD_FROM = 0.28;
const FOLD_TO = 0.72;

/**
 * Dragging rows of the history editor: dropped between rows they move there, dropped onto a
 * commit they fold into it (squash, or fixup with Alt). The list scrolls near its edges.
 */
export function useRowDrag({ scrollRef, order, canFold, onDrop }: RowDragOptions): {
  readonly drag: RowDrag | undefined;
  /** Starts tracking a press on a row; `click` runs when it is released without dragging. */
  readonly press: (event: ReactPointerEvent, shas: () => readonly string[], click?: () => void) => void;
} {
  const [drag, setDrag] = useState<RowDrag>();
  // The latest values for the window listeners of a press in progress.
  const live = useRef({ order, canFold, onDrop });
  useLayoutEffect(() => {
    live.current = { order, canFold, onDrop };
  });
  const cleanup = useRef<(() => void) | undefined>(undefined);

  // A drag never outlives the editor.
  useEffect(() => () => cleanup.current?.(), []);

  // Stable: rows can be memoized (it reads what changes through `live`).
  const press = useCallback(
    (event: ReactPointerEvent, shas: () => readonly string[], click?: () => void) => {
      if (event.button !== 0) return;
      cleanup.current?.();
      const start = { x: event.clientX, y: event.clientY };
      let dragged: readonly string[] | undefined;
      let pointer = { ...start, alt: event.altKey };
      let frame = 0;

      const targetAt = (y: number, alt: boolean): DropTarget | undefined => {
        const scroller = scrollRef.current;
        if (!scroller || !dragged) return undefined;
        const rows = [...scroller.querySelectorAll<HTMLElement>('[data-sha]')];
        if (rows.length === 0) return undefined;
        let index = rows.findIndex((row) => y < row.getBoundingClientRect().bottom);
        if (index < 0) return moveTarget(rows.length);
        const rect = rows[index]!.getBoundingClientRect();
        if (y < rect.top) return moveTarget(index);
        const sha = rows[index]!.dataset.sha!;
        const fraction = (y - rect.top) / rect.height;
        if (dragged.includes(sha)) return undefined;
        if (fraction > FOLD_FROM && fraction < FOLD_TO && live.current.canFold(sha))
          return { kind: 'fold', sha, action: alt ? 'fixup' : 'squash' };
        if (fraction >= 0.5) index++;
        return moveTarget(index);
      };

      /** A move to `index`, unless it would leave the order as it is. */
      const moveTarget = (index: number): DropTarget | undefined => {
        const current = live.current.order;
        const next = moveInOrder(current, dragged!, index);
        return next.every((sha, i) => sha === current[i]) ? undefined : { kind: 'move', index };
      };

      const update = () => {
        if (!dragged) return;
        setDrag({ shas: dragged, x: pointer.x, y: pointer.y, target: targetAt(pointer.y, pointer.alt) });
      };

      // Near the top or bottom edge the list scrolls, faster the closer the pointer is.
      const scroll = () => {
        frame = 0;
        const scroller = scrollRef.current;
        if (!scroller || !dragged) return;
        const rect = scroller.getBoundingClientRect();
        const above = rect.top + EDGE - pointer.y;
        const below = pointer.y - (rect.bottom - EDGE);
        const step = above > 0 ? -Math.ceil(above / 3) : below > 0 ? Math.ceil(below / 3) : 0;
        if (step === 0) return;
        const before = scroller.scrollTop;
        scroller.scrollTop += step;
        if (scroller.scrollTop !== before) update();
        frame = requestAnimationFrame(scroll);
      };

      const onMove = (move: PointerEvent) => {
        pointer = { x: move.clientX, y: move.clientY, alt: move.altKey };
        if (!dragged) {
          if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < THRESHOLD) return;
          dragged = shas();
          if (dragged.length === 0) {
            end();
            return;
          }
        }
        move.preventDefault();
        update();
        if (!frame) frame = requestAnimationFrame(scroll);
      };

      const onUp = (up: PointerEvent) => {
        const wasDragging = !!dragged;
        const target = dragged ? targetAt(up.clientY, up.altKey) : undefined;
        const moved = dragged;
        end();
        if (!wasDragging) click?.();
        else if (moved && target) live.current.onDrop(moved, target);
      };

      // Alt switches between squash and fixup while hovering a commit; Escape cancels.
      const onKey = (key: KeyboardEvent) => {
        if (!dragged) return;
        if (key.key === 'Escape') {
          key.preventDefault();
          key.stopPropagation();
          end();
        } else if (key.key === 'Alt') {
          key.preventDefault();
          pointer = { ...pointer, alt: key.type === 'keydown' };
          update();
        }
      };

      const end = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', end);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('keyup', onKey, true);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        dragged = undefined;
        cleanup.current = undefined;
        setDrag(undefined);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', end);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('keyup', onKey, true);
      cleanup.current = end;
    },
    [scrollRef],
  );

  return { drag, press };
}

/** `order` (newest first) with `moving` taken out and put back at `index` (an index of `order`). */
export function moveInOrder(order: readonly string[], moving: readonly string[], index: number): string[] {
  const set = new Set(moving);
  const rest = order.filter((sha) => !set.has(sha));
  const at = order.slice(0, index).filter((sha) => !set.has(sha)).length;
  const kept = order.filter((sha) => set.has(sha));
  return [...rest.slice(0, at), ...kept, ...rest.slice(at)];
}
