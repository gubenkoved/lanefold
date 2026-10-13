import { describe, expect, it } from 'vitest';
import { besidePointer, EDGE_GAP } from '../../src/webview/views/rewrite/placement';

describe('the drag label of the history editor', () => {
  const view = { width: 520, height: 700 };
  const label = { width: 300, height: 26 };

  it('goes below and to the right of the pointer when there is room', () => {
    expect(besidePointer({ x: 100, y: 200 }, label, view)).toEqual({ left: 114, top: 214 });
  });

  it('stays inside the window near its right edge, and goes above the pointer near the bottom', () => {
    expect(besidePointer({ x: 500, y: 200 }, label, view).left).toBe(520 - EDGE_GAP - 300);
    expect(besidePointer({ x: 100, y: 690 }, label, view).top).toBe(690 - 10 - 26);
  });

  it('keeps its gap from the left and top edges when the window is narrower than it', () => {
    expect(besidePointer({ x: 300, y: 5 }, { width: 600, height: 26 }, view)).toEqual({
      left: EDGE_GAP,
      top: 19,
    });
    expect(besidePointer({ x: 10, y: 20 }, label, { width: 520, height: 40 }).top).toBe(EDGE_GAP);
  });
});
