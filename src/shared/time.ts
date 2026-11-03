/** Date formatting shared by the graph, hovers and blame annotations (Intl only, no DOM). */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const monthDayYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const full = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Formatted calendar dates by day (Intl formatting is slow; graphs repeat dates a lot). */
const dayLabels = new Map<number, string>();

/** Compact relative time for the date column ("just now", "5m ago", "Mar 4", "Mar 4, 2023"). */
export function relativeTime(epochSeconds: number, nowMs = Date.now()): string {
  const delta = Math.max(0, nowMs / 1000 - epochSeconds);
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  const date = new Date(epochSeconds * 1000);
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  // Key: local calendar day plus whether the year is shown.
  const key = (date.getFullYear() * 400 + date.getMonth() * 32 + date.getDate()) * 2 + (sameYear ? 1 : 0);
  let label = dayLabels.get(key);
  if (label === undefined) {
    label = sameYear ? monthDay.format(date) : monthDayYear.format(date);
    if (dayLabels.size > 5000) dayLabels.clear();
    dayLabels.set(key, label);
  }
  return label;
}

/** Calendar dates with their year, by day (see {@link calendarDate}). */
const yearLabels = new Map<number, string>();

/** The calendar day, with its year ("Mar 4, 2023"). */
export function calendarDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const key = date.getFullYear() * 400 + date.getMonth() * 32 + date.getDate();
  let label = yearLabels.get(key);
  if (label === undefined) {
    label = monthDayYear.format(date);
    if (yearLabels.size > 5000) yearLabels.clear();
    yearLabels.set(key, label);
  }
  return label;
}

/** The calendar day as "2023-03-04", in the local time zone. */
export function isoDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function absoluteTime(epochSeconds: number): string {
  return full.format(new Date(epochSeconds * 1000));
}

/** Created on first use: building one is slow, and long lists format a date per row. */
let relativeFormat: Intl.RelativeTimeFormat | undefined;

/** Below each limit (seconds), whole units of that size. */
const RELATIVE_STEPS: readonly [limit: number, unit: Intl.RelativeTimeFormatUnit, size: number][] = [
  [HOUR, 'minute', MINUTE],
  [DAY, 'hour', HOUR],
  [7 * DAY, 'day', DAY],
  [30 * DAY, 'week', 7 * DAY],
  [365 * DAY, 'month', 30 * DAY],
  [Infinity, 'year', 365 * DAY],
];

/** Long relative description for hover cards ("3 days ago"; "just now", as the compact form). */
export function relativeLong(epochSeconds: number, nowMs = Date.now()): string {
  const delta = nowMs / 1000 - epochSeconds;
  if (Math.abs(delta) < MINUTE) return 'just now';
  relativeFormat ??= new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [limit, unit, size] of RELATIVE_STEPS) {
    // Whole units elapsed, like the compact form ("2m ago" and "2 minutes ago" agree).
    if (Math.abs(delta) < limit) return relativeFormat.format(-Math.trunc(delta / size), unit);
  }
  return absoluteTime(epochSeconds);
}
