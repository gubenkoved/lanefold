import type {
  ActivityBucket,
  ActivityUnit,
  AuthorProfile,
  Contributor,
  ContributorSort,
  Hotspot,
  HotspotGroup,
  StatsRange,
  StatsResult,
} from '../../shared/stats';
import {
  activityUnit,
  civilFromDays,
  daysFromCivil,
  isoDate,
  periodDays,
  periodOf,
  weekdayOf,
} from './calendar';
import { personKey, type CommitStore, type LineStore } from './store';

/** What turns a time (seconds) into a calendar day (days since 1970-01-01): the viewer's zone. */
export interface DayCalendar {
  dayOf(seconds: number): number;
}

/** A scope's commits, ready to be counted in one calendar (kept until either changes). */
export interface PreparedScope {
  /** Commit numbers, newest first (git's order). */
  readonly ids: Int32Array;
  /** Each one's calendar day, by position. */
  readonly days: Int32Array;
  /** Positions by day, the oldest first. */
  readonly byDay: Int32Array;
  /**
   * The positions before this one hold the newest commits whose changed lines are counted
   * (the merges among them aside: they have no lines of their own).
   */
  readonly linesEnd: number;
}

/** Orders a scope's commits by day (a counting sort: days are few) and marks its line window. */
export function prepareScope(
  commits: CommitStore,
  ids: Int32Array,
  calendar: DayCalendar,
  lineLimit: number,
): PreparedScope {
  const n = ids.length;
  const days = new Int32Array(n);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const day = calendar.dayOf(commits.time[ids[i]!]!);
    days[i] = day;
    if (day < min) min = day;
    if (day > max) max = day;
  }
  const byDay = new Int32Array(n);
  if (n > 0 && max - min < 4_000_000) {
    const starts = new Int32Array(max - min + 2);
    for (let i = 0; i < n; i++) starts[days[i]! - min + 1]! += 1;
    for (let d = 1; d < starts.length; d++) starts[d]! += starts[d - 1]!;
    for (let i = 0; i < n; i++) byDay[starts[days[i]! - min]!++] = i;
  } else {
    for (let i = 0; i < n; i++) byDay[i] = i;
    byDay.sort((a, b) => days[a]! - days[b]!);
  }
  let linesEnd = 0;
  for (let counted = 0; linesEnd < n && counted < lineLimit; linesEnd++) {
    if (!commits.isMerge(ids[linesEnd]!)) counted++;
  }
  return { ids, days, byDay, linesEnd };
}

/** The first day of a range ending today (`today` included); -Infinity for all time. */
export function rangeStartDay(range: StatsRange, today: number): number {
  if (range === 'all') return -Infinity;
  if (range === '30d') return today - 29;
  const { year, month, day } = civilFromDays(today);
  // The same day 12 or 3 months ago (the end of a shorter month), not included.
  const monthStart = daysFromCivil(year, month - (range === '12m' ? 12 : 3), 1);
  const { year: y, month: m } = civilFromDays(monthStart);
  return Math.min(monthStart + day - 1, daysFromCivil(y, m + 1, 1) - 1) + 1;
}

export interface AggregateInput {
  readonly commits: CommitStore;
  readonly lines: LineStore;
  readonly scope: PreparedScope;
  readonly calendar: DayCalendar;
  /** The newest commits (merges aside) whose lines are counted at most. */
  readonly lineLimit: number;
}

export interface AggregateQuery {
  readonly range: StatsRange;
  /** A contributor's name, or `<email>` (see `Contributor.author`). */
  readonly author?: string;
  readonly sort: ContributorSort;
  readonly hotspots: HotspotGroup;
  /** How many contributors and hotspots to list. */
  readonly contributors: number;
  readonly files: number;
  /** Now, in seconds since the epoch. */
  readonly now: number;
}

/**
 * Everything about a range's commits but their lines: one pass over all of them, the slow part
 * on a large history. It depends on the scope, calendar, range, author and day only, so it can
 * be kept while lines are being counted, or another order or more rows are asked for.
 */
export interface CommitTotals {
  readonly startDay: number;
  /** The person filtered to (-1: nobody known by that name); undefined without a filter. */
  readonly author: number | undefined;
  readonly unit: ActivityUnit;
  /** The first period of the chart, and how many there are. */
  readonly base: number;
  readonly periods: number;
  readonly periodCommits: Int32Array;
  /** Commits per weekday (Monday first) and hour, in each commit's own time zone. */
  readonly punch: Int32Array;
  /** Commits in the range, by everyone. */
  readonly rangeCommits: number;
  /** Commits shown (in the range, by the author filtered to). */
  readonly commits: number;
  readonly merges: number;
  readonly contributors: number;
  readonly activeDays: number;
  readonly first: number;
  readonly last: number;
  /** Per person, in the range (whatever the author filter). */
  readonly personCommits: Int32Array;
  readonly personFirst: Float64Array;
  readonly personLast: Float64Array;
  /** The identity of their latest commit. */
  readonly personLatest: Int32Array;
  readonly personDays: Int32Array;
}

/** Counts the commits of a range (see {@link CommitTotals}). */
export function countCommits(
  input: Pick<AggregateInput, 'commits' | 'scope' | 'calendar'>,
  range: StatsRange,
  authorName: string | undefined,
  now: number,
): CommitTotals {
  const { commits, scope, calendar } = input;
  const { ids, days, byDay } = scope;
  const n = ids.length;
  const today = calendar.dayOf(now);
  const startDay = rangeStartDay(range, today);
  const author = authorName === undefined ? undefined : commits.personId(personKey(authorName, ''));

  // The first commit in the range (by day).
  let from = 0;
  for (let high = n; from < high;) {
    const middle = (from + high) >> 1;
    if (days[byDay[middle]!]! < startDay) from = middle + 1;
    else high = middle;
  }

  // The activity chart spans the range (all time: from the first to the last commit).
  const lastDay = n > 0 ? days[byDay[n - 1]!]! : today;
  const axisStart = range === 'all' ? (from < n ? days[byDay[from]!]! : today) : startDay;
  const axisEnd = Math.max(axisStart, range === 'all' ? lastDay : Math.max(today, lastDay));
  const unit = activityUnit(axisStart, axisEnd);
  const base = periodOf(unit, axisStart);
  const periods = periodOf(unit, axisEnd) - base + 1;
  const periodCommits = new Int32Array(periods);

  const people = commits.people.length;
  const personCommits = new Int32Array(people);
  const personFirst = new Float64Array(people).fill(Infinity);
  const personLast = new Float64Array(people).fill(-Infinity);
  const personLatest = new Int32Array(people).fill(-1);
  const personDays = new Int32Array(people);
  const personLastDay = new Float64Array(people).fill(NaN);
  const shown = new Uint8Array(people);
  const punch = new Int32Array(7 * 24);

  let rangeCommits = 0;
  let shownCommits = 0;
  let merges = 0;
  let contributors = 0;
  let activeDays = 0;
  let previousDay = NaN;
  let first = Infinity;
  let last = -Infinity;
  let periodDay = NaN;
  let period = 0;
  for (let k = from; k < n; k++) {
    const position = byDay[k]!;
    const id = ids[position]!;
    const day = days[position]!;
    const person = commits.personOf(id);
    const time = commits.time[id]!;
    rangeCommits++;
    if (person >= 0) {
      personCommits[person]! += 1;
      if (time < personFirst[person]!) personFirst[person] = time;
      if (time >= personLast[person]!) {
        personLast[person] = time;
        personLatest[person] = commits.identity[id]!;
      }
      if (personLastDay[person] !== day) {
        personLastDay[person] = day;
        personDays[person]! += 1;
      }
    }
    if (author !== undefined && person !== author) continue;

    shownCommits++;
    if (commits.isMerge(id)) merges++;
    if (person >= 0 && !shown[person]) {
      shown[person] = 1;
      contributors++;
    }
    if (day !== previousDay) {
      activeDays++;
      previousDay = day;
    }
    if (time < first) first = time;
    if (time > last) last = time;
    // Commits come by day: the period changes rarely.
    if (day !== periodDay) {
      periodDay = day;
      period = Math.min(periods - 1, Math.max(0, periodOf(unit, day) - base));
    }
    periodCommits[period]! += 1;
    // The punch card reads each commit's clock where it was made.
    const local = time + commits.offset[id]! * 60;
    const localDay = Math.floor(local / 86_400);
    const hour = Math.min(23, Math.floor((local - localDay * 86_400) / 3600));
    punch[weekdayOf(localDay) * 24 + hour]! += 1;
  }

  return {
    startDay,
    author,
    unit,
    base,
    periods,
    periodCommits,
    punch,
    rangeCommits,
    commits: shownCommits,
    merges,
    contributors,
    activeDays,
    first,
    last,
    personCommits,
    personFirst,
    personLast,
    personLatest,
    personDays,
  };
}

export type Aggregate = Omit<StatsResult, 'head'>;

/** A growable list of number pairs. */
class Pairs {
  data = new Int32Array(1024);
  length = 0;
  push(a: number, b: number): void {
    if (this.length + 2 > this.data.length) {
      const grown = new Int32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
  }
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2 === 1 ? values[middle]! : Math.round((values[middle - 1]! + values[middle]!) / 2);
}

/** The top-level folder of a path ('' for a file at the top level). */
function folderOf(path: string): string {
  const slash = path.indexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * The Statistics view's numbers for a scope: the summary, activity, punch card and hotspots of
 * the commits in the range (and of the author, with a filter), and every author's share of the
 * range. Lines come from the commits in the line window whose numstat is known; renamed files
 * are counted under their newest name. `totals` may be kept from an earlier call with the same
 * scope, calendar, range, author and day (see {@link countCommits}).
 */
export function aggregateStats(
  input: AggregateInput,
  query: AggregateQuery,
  totals: CommitTotals = countCommits(input, query.range, query.author, query.now),
): Aggregate {
  const { commits, lines, scope } = input;
  const { ids, days, linesEnd } = scope;
  const { startDay, author, unit, base, periods } = totals;
  const n = ids.length;
  const people = commits.people.length;
  const personAdded = new Float64Array(people);
  const personRemoved = new Float64Array(people);
  const periodAdded = new Float64Array(periods);
  const periodRemoved = new Float64Array(periods);
  const sizes: number[] = [];
  let counted = 0;
  let added = 0;
  let removed = 0;
  const nonMerges = totals.commits - totals.merges;

  // ---- lines and files: the line window, newest first, so renames can be followed back -------
  const paths = lines.paths;
  const alias = new Int32Array(paths.length).fill(-1);
  const stamp = new Int32Array(paths.length).fill(-1);
  const fileCommits = new Int32Array(paths.length);
  const fileAdded = new Float64Array(paths.length);
  const fileRemoved = new Float64Array(paths.length);
  const folders = query.hotspots === 'folders';
  const folderIds = new Map<string, number>();
  const folderNames: string[] = [];
  const folderOfPath = new Int32Array(folders ? paths.length : 0).fill(-1);
  const folderStamp: number[] = [];
  const folderCommits: number[] = [];
  const folderAdded: number[] = [];
  const folderRemoved: number[] = [];
  const touched = new Pairs();
  const canonical: number[] = [];
  let files = 0;
  let missing = 0;
  for (let position = 0; position < linesEnd; position++) {
    const id = ids[position]!;
    if (commits.isMerge(id)) continue;
    const commitLines = lines.get(id);
    if (!commitLines) {
      missing++;
      continue;
    }
    const person = commits.personOf(id);
    const day = days[position]!;
    const inRange = day >= startDay;
    if (inRange && person >= 0) {
      personAdded[person]! += commitLines.added;
      personRemoved[person]! += commitLines.removed;
    }
    const included = inRange && (author === undefined || person === author);
    if (included) {
      counted++;
      added += commitLines.added;
      removed += commitLines.removed;
      const period = Math.min(periods - 1, Math.max(0, periodOf(unit, day) - base));
      periodAdded[period]! += commitLines.added;
      periodRemoved[period]! += commitLines.removed;
      sizes.push(commitLines.added + commitLines.removed);
    }
    const entries = commitLines.files;
    canonical.length = 0;
    for (let e = 0; e < entries.length; e += 4) {
      const path = entries[e]!;
      // What the file is called now (it may have been renamed since).
      const name = alias[path]! >= 0 ? alias[path]! : path;
      canonical.push(name);
      if (!included) continue;
      const fileAdds = Math.max(0, entries[e + 2]!);
      const fileRemoves = Math.max(0, entries[e + 3]!);
      if (stamp[name] !== position) {
        stamp[name] = position;
        if (fileCommits[name] === 0) files++;
        fileCommits[name]! += 1;
        if (!folders) touched.push(name, person);
      }
      fileAdded[name]! += fileAdds;
      fileRemoved[name]! += fileRemoves;
      if (folders) {
        let folder = folderOfPath[name]!;
        if (folder < 0) {
          const folderName = folderOf(paths[name]!);
          folder = folderIds.get(folderName) ?? -1;
          if (folder < 0) {
            folder = folderNames.length;
            folderIds.set(folderName, folder);
            folderNames.push(folderName);
            folderStamp.push(-1);
            folderCommits.push(0);
            folderAdded.push(0);
            folderRemoved.push(0);
          }
          folderOfPath[name] = folder;
        }
        if (folderStamp[folder] !== position) {
          folderStamp[folder] = position;
          folderCommits[folder]! += 1;
          touched.push(folder, person);
        }
        folderAdded[folder]! += fileAdds;
        folderRemoved[folder]! += fileRemoves;
      }
    }
    // Older commits name a renamed file by its old path: count them under the new one.
    for (let e = 0, i = 0; e < entries.length; e += 4, i++) {
      const old = entries[e + 1]!;
      if (old >= 0) alias[old] = canonical[i]!;
    }
  }

  // ---- hotspots -----------------------------------------------------------------------------
  const candidates: number[] = [];
  if (folders) {
    for (let folder = 0; folder < folderNames.length; folder++)
      if (folderCommits[folder]! > 0) candidates.push(folder);
  } else {
    for (let path = 0; path < paths.length; path++) if (fileCommits[path]! > 0) candidates.push(path);
  }
  const spotCommits = (i: number) => (folders ? folderCommits[i]! : fileCommits[i]!);
  const spotAdded = (i: number) => (folders ? folderAdded[i]! : fileAdded[i]!);
  const spotRemoved = (i: number) => (folders ? folderRemoved[i]! : fileRemoved[i]!);
  const spotName = (i: number) => (folders ? folderNames[i]! : paths[i]!);
  candidates.sort(
    (a, b) =>
      spotCommits(b) - spotCommits(a) ||
      spotAdded(b) + spotRemoved(b) - spotAdded(a) - spotRemoved(a) ||
      (spotName(a) < spotName(b) ? -1 : spotName(a) > spotName(b) ? 1 : 0),
  );
  const top = candidates.slice(0, Math.max(0, query.files));
  const authorsOf = new Map<number, Set<number>>(top.map((index) => [index, new Set<number>()]));
  for (let i = 0; i < touched.length; i += 2) authorsOf.get(touched.data[i]!)?.add(touched.data[i + 1]!);
  const hotspots: Hotspot[] = top.map((index) => ({
    path: spotName(index),
    commits: spotCommits(index),
    added: spotAdded(index),
    removed: spotRemoved(index),
    authors: authorsOf.get(index)!.size,
  }));

  // ---- contributors -------------------------------------------------------------------------
  const { personCommits, personFirst, personLast, personLatest, personDays, rangeCommits } = totals;
  // People who first appeared after the totals were counted have no commits in them.
  const commitsOf = (person: number) => (person < personCommits.length ? personCommits[person]! : 0);
  const contributorRow = (person: number): Contributor => {
    const latest = commits.identities[personLatest[person]!]!;
    const emails = [latest.email];
    for (const identity of commits.identities) {
      if (emails.length >= 5) break;
      if (identity.person === person && identity.email && !emails.includes(identity.email))
        emails.push(identity.email);
    }
    const key = commits.people[person]!;
    return {
      author: key.startsWith('<') ? key : latest.name || key,
      name: latest.name || latest.email,
      email: latest.email,
      emails: emails.filter(Boolean),
      commits: commitsOf(person),
      share: rangeCommits > 0 ? commitsOf(person) / rangeCommits : 0,
      added: personAdded[person]!,
      removed: personRemoved[person]!,
      first: personFirst[person]!,
      last: personLast[person]!,
      activeDays: personDays[person]!,
    };
  };
  const active: number[] = [];
  for (let person = 0; person < personCommits.length; person++)
    if (personCommits[person]! > 0) active.push(person);
  const lineTotal = (person: number) => personAdded[person]! + personRemoved[person]!;
  const byKey = (a: number, b: number) => (commits.people[a]! < commits.people[b]! ? -1 : 1);
  active.sort((a, b) => {
    if (query.sort === 'lines')
      return lineTotal(b) - lineTotal(a) || commitsOf(b) - commitsOf(a) || byKey(a, b);
    if (query.sort === 'recent') return personLast[b]! - personLast[a]! || byKey(a, b);
    return commitsOf(b) - commitsOf(a) || lineTotal(b) - lineTotal(a) || byKey(a, b);
  });

  let profile: AuthorProfile | undefined;
  if (author !== undefined && author >= 0 && commitsOf(author) > 0) {
    const { punch } = totals;
    const weekdays = Array.from({ length: 7 }, (_, weekday) => {
      let sum = 0;
      for (let hour = 0; hour < 24; hour++) sum += punch[weekday * 24 + hour]!;
      return sum;
    });
    const hours = Array.from({ length: 24 }, (_, hour) => {
      let sum = 0;
      for (let weekday = 0; weekday < 7; weekday++) sum += punch[weekday * 24 + hour]!;
      return sum;
    });
    // A weekday only when one stands out; the two hours around the busiest one (the earlier
    // pair only when it holds more), when they hold a third of the commits at least.
    const top = Math.max(...weekdays);
    const weekday =
      weekdays.filter((value) => value === top).length === 1 ? weekdays.indexOf(top) : undefined;
    const peak = hours.indexOf(Math.max(...hours));
    const before = (peak + 23) % 24;
    const after = (peak + 1) % 24;
    const start = hours[before]! > hours[after]! ? before : peak;
    const held = hours[start]! + hours[(start + 1) % 24]!;
    profile = {
      ...contributorRow(author),
      weekday,
      hours: held * 3 >= totals.commits ? [start, (start + 2) % 24] : undefined,
    };
  }

  // ---- where line counts stop, for the chart -------------------------------------------------
  let linesFrom: number | undefined;
  if (counted < nonMerges) {
    // The newest commit shown whose lines are not counted: the periods before its own have none.
    for (let position = 0; position < n; position++) {
      const id = ids[position]!;
      if (commits.isMerge(id) || days[position]! < startDay) continue;
      if (author !== undefined && commits.personOf(id) !== author) continue;
      if (position < linesEnd && lines.has(id)) continue;
      linesFrom = Math.min(periods - 1, Math.max(0, periodOf(unit, days[position]!) - base));
      break;
    }
  }

  const buckets: ActivityBucket[] = Array.from({ length: n > 0 ? periods : 0 }, (_, index) => {
    const [start, end] = periodDays(unit, base + index);
    return {
      start: isoDate(start),
      end: isoDate(end),
      commits: totals.periodCommits[index]!,
      added: periodAdded[index]!,
      removed: periodRemoved[index]!,
    };
  });

  return {
    scopeCommits: n,
    summary: {
      commits: totals.commits,
      merges: totals.merges,
      contributors: totals.contributors,
      added,
      removed,
      files,
      activeDays: totals.activeDays,
      first: totals.commits > 0 ? totals.first : undefined,
      last: totals.commits > 0 ? totals.last : undefined,
      medianLines: median(sizes),
    },
    activity: { unit, buckets, linesFrom },
    contributors: {
      total: active.length,
      rows: active.slice(0, Math.max(0, query.contributors)).map(contributorRow),
    },
    author: profile,
    punchCard: Array.from(totals.punch),
    hotspots: { total: folders ? folderNames.length : files, rows: hotspots },
    lines: { counted, total: nonMerges, limit: input.lineLimit, pending: missing > 0 },
  };
}
