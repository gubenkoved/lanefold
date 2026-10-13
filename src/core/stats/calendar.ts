import type { ActivityUnit } from '../../shared/stats';

/** Calendar days as numbers (days since 1970-01-01) and the periods of the activity chart. */

const DAY = 86_400;

export interface CivilDate {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  readonly day: number;
}

/** The date of a day number (proleptic Gregorian calendar; Howard Hinnant's algorithm). */
export function civilFromDays(days: number): CivilDate {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** The day number of a date (months and days out of range roll over, as with `Date.UTC`). */
export function daysFromCivil(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** "2024-03-01". */
export function isoDate(days: number): string {
  const { year, month, day } = civilFromDays(days);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 0 for Monday … 6 for Sunday (1970-01-01 was a Thursday). */
export function weekdayOf(days: number): number {
  return (((days + 3) % 7) + 7) % 7;
}

/** The period of `unit` a day falls in, as a number: consecutive periods have consecutive numbers. */
export function periodOf(unit: ActivityUnit, days: number): number {
  switch (unit) {
    case 'day':
      return days;
    case 'week':
      // Weeks start on Monday: day 4 (1970-01-05) begins week 1.
      return Math.floor((days + 3) / 7);
    default: {
      const { year, month } = civilFromDays(days);
      if (unit === 'month') return year * 12 + month - 1;
      if (unit === 'quarter') return year * 4 + Math.floor((month - 1) / 3);
      return year;
    }
  }
}

/** The first and the last day of a period (see {@link periodOf}). */
export function periodDays(unit: ActivityUnit, period: number): readonly [number, number] {
  switch (unit) {
    case 'day':
      return [period, period];
    case 'week':
      return [period * 7 - 3, period * 7 + 3];
    case 'month': {
      const year = Math.floor(period / 12);
      const month = period - year * 12 + 1;
      return [daysFromCivil(year, month, 1), daysFromCivil(year, month + 1, 1) - 1];
    }
    case 'quarter': {
      const year = Math.floor(period / 4);
      const month = (period - year * 4) * 3 + 1;
      return [daysFromCivil(year, month, 1), daysFromCivil(year, month + 3, 1) - 1];
    }
    case 'year':
      return [daysFromCivil(period, 1, 1), daysFromCivil(period + 1, 1, 1) - 1];
  }
}

const UNITS: readonly ActivityUnit[] = ['day', 'week', 'month', 'quarter', 'year'];
const MIN_PERIODS = 20;
const MAX_PERIODS = 80;

/**
 * The period for an activity chart from `first` to `last` (days): the shortest one that needs at
 * most 80 bars. When that leaves fewer than 20, the shorter one is taken if it is the nearer miss
 * (91 days are better as 91 days than as 13 weeks).
 */
export function activityUnit(first: number, last: number): ActivityUnit {
  let finer: { readonly unit: ActivityUnit; readonly count: number } | undefined;
  for (const unit of UNITS) {
    const count = periodOf(unit, last) - periodOf(unit, first) + 1;
    if (count <= MAX_PERIODS) {
      if (count < MIN_PERIODS && finer && finer.count / MAX_PERIODS < MIN_PERIODS / count) return finer.unit;
      return unit;
    }
    finer = { unit, count };
  }
  return 'year';
}

/** The host's own time zone, when the viewer's is unknown or not one this runtime knows. */
function hostTimeZone(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function zoneFormat(timeZone: string | undefined): Intl.DateTimeFormat | undefined {
  if (!timeZone || timeZone === 'UTC' || timeZone === 'Etc/UTC') return undefined;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
}

/**
 * The calendar days of a time zone (the viewer's): which day a time falls on there. Offsets are
 * looked up once per UTC day, exactly only on the days a zone changes its offset (DST).
 */
export class ZoneCalendar {
  readonly timeZone: string;
  private readonly format: Intl.DateTimeFormat | undefined;
  /** Offset (minutes) by UTC day; NaN on a day the offset changes. */
  private readonly offsets = new Map<number, number>();

  constructor(timeZone?: string) {
    let format: Intl.DateTimeFormat | undefined;
    let zone = timeZone;
    try {
      format = zoneFormat(zone);
    } catch {
      // Not a zone this runtime knows: the host's own.
      zone = hostTimeZone();
      try {
        format = zoneFormat(zone);
      } catch {
        zone = 'UTC';
      }
    }
    this.format = format;
    this.timeZone = format ? (zone ?? 'UTC') : 'UTC';
  }

  /** Minutes east of UTC at a time (seconds). */
  offsetAt(seconds: number): number {
    if (!this.format) return 0;
    const day = Math.floor(seconds / DAY);
    let offset = this.offsets.get(day);
    if (offset === undefined) {
      const start = this.exactOffset(day * DAY);
      offset = start === this.exactOffset(day * DAY + DAY - 1) ? start : NaN;
      if (this.offsets.size > 200_000) this.offsets.clear();
      this.offsets.set(day, offset);
    }
    return Number.isNaN(offset) ? this.exactOffset(seconds) : offset;
  }

  /** The local calendar day (days since 1970-01-01) of a time (seconds). */
  dayOf(seconds: number): number {
    return Math.floor((seconds + this.offsetAt(seconds) * 60) / DAY);
  }

  private exactOffset(seconds: number): number {
    const at = Math.floor(seconds);
    const parts = this.format!.formatToParts(new Date(at * 1000));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
    const local = Date.UTC(
      part('year'),
      part('month') - 1,
      part('day'),
      part('hour') % 24,
      part('minute'),
      part('second'),
    );
    return Math.round((local / 1000 - at) / 60);
  }
}
