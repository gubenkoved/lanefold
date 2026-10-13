/** Room (px) a floating label keeps from the window's edges. */
export const EDGE_GAP = 8;

/**
 * Where a label that follows the pointer goes (its top-left corner): below and to the right of
 * the pointer, but always inside the window: shifted left near its right edge, above the pointer
 * near its bottom. A label wider than the window is kept from overflowing by its max-width.
 */
export function besidePointer(
  pointer: { readonly x: number; readonly y: number },
  label: { readonly width: number; readonly height: number },
  view: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number } {
  const left = Math.max(EDGE_GAP, Math.min(pointer.x + 14, view.width - EDGE_GAP - label.width));
  const below = pointer.y + 14;
  const top =
    below + label.height > view.height - EDGE_GAP ? Math.max(EDGE_GAP, pointer.y - 10 - label.height) : below;
  return { left, top };
}
