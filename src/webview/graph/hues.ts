/*
 * The hues of the lane palette, apart from the colors made of them (theme tones, see palette.ts):
 * pure, so views can tell which lane colors are close to colors that mean something else.
 */

/** The trunk's hue (blue): lane 0 of every log. */
export const TRUNK_HUE = 252;
const GOLDEN_ANGLE = 137.508;

/** Degrees between two hues (0–180). */
export function hueDistance(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/** The lane palette's hues: the trunk's, then `size` branch hues spaced by the golden angle. */
export function laneHues(size: number): number[] {
  const hues = [TRUNK_HUE];
  let hue = 28;
  while (hues.length < size + 1) {
    // Keep branch hues clearly distinct from the trunk blue.
    if (hueDistance(hue, TRUNK_HUE) > 28) hues.push(hue);
    hue = (hue + GOLDEN_ANGLE) % 360;
  }
  return hues;
}

/**
 * The branch colors (palette indices 1…size) whose hues keep `clearance` degrees from every hue
 * of `avoid` (colors that mean something else in the view, such as repositories'). All of them
 * when that leaves too few to tell neighbouring lanes apart.
 */
export function lanesClearOf(avoid: readonly number[], size: number, clearance = 30): number[] {
  const hues = laneHues(size);
  const all = hues.map((_, index) => index).slice(1);
  const clear = all.filter((index) => avoid.every((hue) => hueDistance(hues[index]!, hue) >= clearance));
  return clear.length >= 3 ? clear : all;
}
