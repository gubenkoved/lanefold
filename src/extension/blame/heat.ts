/**
 * Age heat for blame annotations: recent changes glow warm, old ones fade to a cool blue. The
 * scale is relative to the file's own history: a blend of each commit's rank among the file's
 * commits (so every change stands apart) and its place in time (so close dates look alike).
 */

type Rgb = readonly [number, number, number];

/** Warm (new) → violet → cool (old), per theme brightness. */
const STOPS: Record<'dark' | 'light', readonly Rgb[]> = {
  dark: [
    [255, 170, 80],
    [214, 128, 190],
    [136, 128, 214],
    [104, 130, 176],
  ],
  light: [
    [228, 110, 20],
    [196, 70, 150],
    [120, 100, 200],
    [140, 158, 184],
  ],
};

/** Heat (0 = oldest, 1 = newest) for each distinct commit time of a file. */
export function heatScale(times: readonly number[]): (time: number) => number {
  const distinct = [...new Set(times)].sort((a, b) => a - b);
  if (distinct.length <= 1) return () => 1;
  const oldest = distinct[0]!;
  const newest = distinct[distinct.length - 1]!;
  const rank = new Map(distinct.map((time, index) => [time, index / (distinct.length - 1)]));
  return (time) => {
    const byTime = (Math.min(newest, Math.max(oldest, time)) - oldest) / (newest - oldest);
    return 0.6 * (rank.get(time) ?? byTime) + 0.4 * byTime;
  };
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgba([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha.toFixed(3)})`;
}

export interface HeatColors {
  /** The bar at the left of the annotation. */
  readonly bar: string;
  /** A faint tint behind the annotation text. */
  readonly background: string;
}

export function heatColors(heat: number, theme: 'dark' | 'light'): HeatColors {
  const stops = STOPS[theme];
  // stops[0] is the newest: walk from new (heat 1) to old (heat 0).
  const position = (1 - Math.min(1, Math.max(0, heat))) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const color = mix(stops[index]!, stops[index + 1]!, position - index);
  return {
    bar: rgba(color, 0.7 + 0.3 * heat),
    background: rgba(color, (theme === 'dark' ? 0.05 : 0.07) + 0.09 * heat),
  };
}
