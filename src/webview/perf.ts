/**
 * Performance marks for diagnosing load times (visible in DevTools and read by perf tests).
 * Capped, so long sessions with many reloads do not accumulate entries.
 */
let remaining = 200;

export function mark(name: string): void {
  if (remaining <= 0) return;
  remaining--;
  performance.mark(`lanefold:${name}`);
}
