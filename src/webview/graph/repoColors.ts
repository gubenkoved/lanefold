import { oklchToRgb, rgbCss, type Palette, type ThemeKind } from './palette';
import { REPO_HUES, repoHue } from './repoColorSlots';

/** Lightness and chroma of repository colors per theme: as legible as lane colors. */
const TONE: Record<ThemeKind, { l: number; c: number }> = {
  dark: { l: 0.72, c: 0.15 },
  light: { l: 0.6, c: 0.17 },
  'hc-dark': { l: 0.85, c: 0.18 },
  'hc-light': { l: 0.45, c: 0.2 },
};

const colors = new Map<string, { readonly rgb: readonly [number, number, number]; readonly css: string }>();

/** A repository color slot's color, made once per theme kind. */
function slotColor(slot: number, kind: ThemeKind) {
  const key = `${kind}:${slot}`;
  let color = colors.get(key);
  if (!color) {
    const tone = TONE[kind];
    const light = kind === 'light' || kind === 'hc-light';
    const tier = Math.floor(slot / REPO_HUES) % 2;
    const lightness = tone.l + tier * (light ? 0.12 : -0.14);
    const rgb = oklchToRgb(lightness, tone.c, repoHue(slot));
    color = { rgb, css: rgbCss(rgb) };
    colors.set(key, color);
  }
  return color;
}

/**
 * The color of a repository color slot (see `assignColorSlots`), in the theme's tone: 12 hues
 * 30° apart, then the same hues lighter (light themes) or darker. Memoized.
 */
export function repoColor(slot: number, kind: ThemeKind): string {
  return slotColor(slot, kind).css;
}

/** The lane color index of repository color slot 0 (see `repoLaneColor`), past any lane palette. */
const REPO_COLOR_BASE = 32;
/** Repository color slots a lane color index can stand for: two tiers of every hue, all there are. */
const REPO_SLOTS = REPO_HUES * 2;

/**
 * The lane color index of a repository's color: a line of history drawn in it (a repository's
 * main line in the log of several) takes this index (`laneColors` has the color there).
 */
export function repoLaneColor(slot: number): number {
  return REPO_COLOR_BASE + (slot % REPO_SLOTS);
}

/** A palette's colors by lane color index, repository colors included (from REPO_COLOR_BASE). */
export function laneColors(palette: Palette): {
  readonly css: readonly string[];
  readonly rgb: readonly (readonly [number, number, number])[];
} {
  const css = [...palette.css];
  const rgb = [...palette.rgb];
  // No lane takes the indices in between: they stand in for the trunk's color.
  while (css.length < REPO_COLOR_BASE) css.push(palette.css[0]!);
  while (rgb.length < REPO_COLOR_BASE) rgb.push(palette.rgb[0]!);
  for (let slot = 0; slot < REPO_SLOTS; slot++) {
    const color = slotColor(slot, palette.kind);
    css.push(color.css);
    rgb.push(color.rgb);
  }
  return { css, rgb };
}

/** The CSS color of a lane color index: a palette color, or a repository's. */
export function laneColor(palette: Palette, index: number): string | undefined {
  return index >= REPO_COLOR_BASE ? repoColor(index - REPO_COLOR_BASE, palette.kind) : palette.css[index];
}
