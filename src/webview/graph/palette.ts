/**
 * Theme-adaptive lane colors generated in OKLCH (perceptually uniform), so every lane color has
 * the same visual weight and contrast against the background. Color 0 is the trunk.
 */

import { laneHues } from './hues';

export type ThemeKind = 'dark' | 'light' | 'hc-dark' | 'hc-light';

export function detectThemeKind(body: HTMLElement = document.body): ThemeKind {
  if (body.classList.contains('vscode-high-contrast-light')) return 'hc-light';
  if (body.classList.contains('vscode-high-contrast')) return 'hc-dark';
  if (body.classList.contains('vscode-light')) return 'light';
  return 'dark';
}

/** OKLCH → sRGB (0..1 channels), with gamut mapping by reducing chroma. */
export function oklchToRgb(l: number, c: number, hueDegrees: number): [number, number, number] {
  const h = (hueDegrees * Math.PI) / 180;
  for (let chroma = c; chroma >= 0; chroma -= 0.005) {
    const a = chroma * Math.cos(h);
    const b = chroma * Math.sin(h);
    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.291485548 * b;
    const L = l_ ** 3;
    const M = m_ ** 3;
    const S = s_ ** 3;
    const lin = [
      4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
      -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
      -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
    ];
    if (lin.every((v) => v >= -0.0005 && v <= 1.0005)) {
      return lin.map((v) => {
        const x = Math.min(1, Math.max(0, v));
        return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
      }) as [number, number, number];
    }
  }
  return [l, l, l];
}

export function rgbCss([r, g, b]: readonly number[], alpha = 1): string {
  const to = (v: number) => Math.round(v! * 255);
  return alpha >= 1
    ? `rgb(${to(r!)}, ${to(g!)}, ${to(b!)})`
    : `rgba(${to(r!)}, ${to(g!)}, ${to(b!)}, ${alpha})`;
}

/** Relative luminance (for picking readable text on a solid color). */
export function luminance([r, g, b]: readonly number[]): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

const TONE: Record<ThemeKind, { l: number; c: number }> = {
  dark: { l: 0.75, c: 0.14 },
  light: { l: 0.57, c: 0.16 },
  'hc-dark': { l: 0.84, c: 0.17 },
  'hc-light': { l: 0.46, c: 0.19 },
};

export interface Palette {
  readonly kind: ThemeKind;
  /** RGB (0..1) per color index; index 0 is the trunk. */
  readonly rgb: readonly (readonly [number, number, number])[];
  /** CSS colors per index. */
  readonly css: readonly string[];
}

/** Builds the palette: trunk blue + `size` branch hues spaced by the golden angle. */
export function buildPalette(kind: ThemeKind, size = 10, overrides: readonly string[] = []): Palette {
  const tone = TONE[kind];
  // The trunk a little stronger than the branches.
  const rgb = laneHues(size).map((hue, index) =>
    oklchToRgb(tone.l, index === 0 ? tone.c * 1.05 : tone.c, hue),
  );
  const css = rgb.map((color) => rgbCss(color));
  if (overrides.length > 0) {
    // User colors replace the branch colors (the trunk keeps the first override if given).
    return { kind, rgb, css: css.map((color, i) => overrides[i % overrides.length] ?? color) };
  }
  return { kind, rgb, css };
}

const avatarColors = new Map<string, string>();

/** Muted color for an author avatar, derived from a stable hash (memoized: 360 hues per kind). */
export function avatarColor(hash: number, kind: ThemeKind): string {
  const key = `${kind}:${hash % 360}`;
  let color = avatarColors.get(key);
  if (!color) {
    const light = kind === 'light' || kind === 'hc-light';
    color = rgbCss(oklchToRgb(light ? 0.82 : 0.42, 0.07, hash % 360));
    avatarColors.set(key, color);
  }
  return color;
}
