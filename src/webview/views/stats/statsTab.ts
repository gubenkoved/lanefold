import type { ActivityUnit, StatsConfig, StatsScope } from '../../../shared/stats';
import { useApp } from '../../state/store';

/** The Statistics tab's icon (a bar chart). */
export const STATS_ICON = 'graph';

/**
 * Activates the Statistics tab (there is one at most), opening it if there is none; `patch`
 * changes what it shows (an author to filter to, say).
 */
export function openStats(patch?: Partial<StatsConfig>): void {
  const { tabs, activateTab, addTab, updateTab } = useApp.getState();
  const existing = tabs.tabs.find((tab) => tab.kind === 'stats');
  if (!existing) {
    addTab({ kind: 'stats', title: 'Statistics', stats: patch });
    return;
  }
  if (patch) updateTab(existing.id, { stats: { ...existing.stats, ...patch } });
  activateTab(existing.id);
}

/** A new log tab of a scope's history, searching (an author's commits, a period's). */
export function openLogSearch(scope: StatsScope, title: string, search: string): void {
  useApp.getState().addTab({ kind: 'log', title, view: { scope: { type: scope } }, search: search.trim() });
}

/** English weekday names, Monday first (the statistics' sentences are English). */
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** A local date from a calendar day ("2024-03-01"). */
export function localDate(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date!);
}

const longDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const monthYear = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const shortMonth = new Intl.DateTimeFormat(undefined, { month: 'short' });
const weekdayDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

/** "Mar 4, 2024", for a time in seconds. */
export function dateText(seconds: number): string {
  return longDate.format(new Date(seconds * 1000));
}

/** "Feb 2 – Jun 10, 2024" (the year once when both share it). */
export function dateRange(first: number, last: number): string {
  const a = new Date(first * 1000);
  const b = new Date(last * 1000);
  if (a.toDateString() === b.toDateString()) return longDate.format(a);
  if (a.getFullYear() === b.getFullYear()) return `${shortDate.format(a)} – ${longDate.format(b)}`;
  return `${longDate.format(a)} – ${longDate.format(b)}`;
}

function quarter(date: Date): string {
  return `Q${Math.floor(date.getMonth() / 3) + 1} ${date.getFullYear()}`;
}

/** A chart period in words: "Week of Mar 4, 2024", "March 2024", "Q1 2024"… */
export function periodText(unit: ActivityUnit, start: string): string {
  const date = localDate(start);
  switch (unit) {
    case 'day':
      return weekdayDate.format(date);
    case 'week':
      return `Week of ${longDate.format(date)}`;
    case 'month':
      return monthYear.format(date);
    case 'quarter':
      return quarter(date);
    case 'year':
      return String(date.getFullYear());
  }
}

/** A short axis label for a period: "Mar 4", "Mar", "Q1 2024", "2024" (years where they change). */
export function axisText(unit: ActivityUnit, start: string, withYear: boolean): string {
  const date = localDate(start);
  switch (unit) {
    case 'day':
    case 'week':
      return withYear ? longDate.format(date) : shortDate.format(date);
    case 'month':
      return withYear ? `${shortMonth.format(date)} ${date.getFullYear()}` : shortMonth.format(date);
    case 'quarter':
      return quarter(date);
    case 'year':
      return String(date.getFullYear());
  }
}

/** What the chart's periods are called ("week"), for "commits per week". */
export const UNIT_NAMES: Readonly<Record<ActivityUnit, string>> = {
  day: 'day',
  week: 'week',
  month: 'month',
  quarter: 'quarter',
  year: 'year',
};

/** A count with its noun: "1 commit", "1,204 commits". */
export function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? noun : nouns}`;
}

/** A share as a percentage: "35%", "<1%". */
export function percent(share: number): string {
  if (share > 0 && share < 0.005) return '<1%';
  return `${Math.round(share * 100)}%`;
}

/** A size in bytes: "840 B", "12.4 KB", "3.1 MB". */
export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

/** "10:00–12:00". */
export function hoursText([from, to]: readonly [number, number]): string {
  const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
  return `${hour(from)}–${hour(to)}`;
}
