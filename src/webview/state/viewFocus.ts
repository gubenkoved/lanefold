import { useEffect } from 'react';
import { create } from 'zustand';
import type { TabKind } from './tabs';

/** What can be asked to take focus: a tab's view, or the commit box of the uncommitted changes. */
export type FocusTarget = TabKind | 'commitBox';

interface FocusRequest {
  readonly kind?: FocusTarget;
  /** What had focus when the view was asked for (the button that opened it, the menu's opener). */
  readonly from?: Element | null;
  readonly at: number;
}

const useFocusRequest = create<FocusRequest>(() => ({ at: 0 }));

/** A request this old is dropped: the view never got ready (it failed), and the user moved on. */
const REQUEST_MS = 5000;

/**
 * Asks the view of `kind` to take keyboard focus once it shows: a view opened by a command (a
 * menu item, a button) is where the user goes next. Choosing a tab in the tab strip leaves focus
 * there, as tab lists do. The commit box is asked for the same way: the log view in front gives
 * it the cursor once it is there (its details pane may be opening still).
 */
export function focusWhenShown(kind: FocusTarget): void {
  useFocusRequest.setState({ kind, from: document.activeElement, at: Date.now() });
}

/**
 * Takes focus for a view of `kind` when it was asked to, once `ready` (shown, its content in
 * place): `focus` moves it and says whether it found where to (else it is tried again on the
 * next render). Focus the user moved elsewhere meanwhile stays where it is.
 */
export function useFocusWhenShown(kind: FocusTarget, ready: boolean, focus: () => boolean): void {
  const request = useFocusRequest((state) => (state.kind === kind ? state : undefined));
  useEffect(() => {
    if (!request || !ready) return;
    const active = document.activeElement;
    const moved =
      !!active && active !== document.body && active !== request.from && !!request.from?.isConnected;
    if (moved || Date.now() - request.at > REQUEST_MS || focus())
      useFocusRequest.setState({ kind: undefined, from: undefined });
  });
}
