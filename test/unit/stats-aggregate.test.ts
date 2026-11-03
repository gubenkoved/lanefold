import { describe, expect, it } from 'vitest';
import {
  aggregateStats,
  countCommits,
  prepareScope,
  rangeStartDay,
  type AggregateQuery,
  type DayCalendar,
} from '../../src/core/stats/aggregate';
import { daysFromCivil, isoDate, ZoneCalendar } from '../../src/core/stats/calendar';
import { CommitStore, LineStore } from '../../src/core/stats/store';

/** A commit for the fixtures: author "Name <email>", ISO time with its offset, files changed. */
interface Spec {
  readonly author: string;
  readonly at: string;
  readonly merge?: boolean;
  /** [path, added, removed, old path]; undefined counts for a binary file. Without: lines unknown. */
  readonly files?: readonly (readonly [string, number | undefined, number | undefined, string?])[];
}

const UTC: DayCalendar = { dayOf: (seconds) => Math.floor(seconds / 86_400) };
const NOW = Date.parse('2024-06-15T12:00:00Z') / 1000;

/** Builds the stores from commits listed newest first (git's order). */
function build(specs: readonly Spec[]) {
  const commits = new CommitStore();
  const lines = new LineStore();
  const ids = specs.map((spec, index) => {
    const sha = (index + 1).toString(16).padStart(40, '0');
    const [, name = '', email = ''] = /^(.*?) ?<(.*)>$/.exec(spec.author)!;
    const zone = /([+-])(\d\d):(\d\d)$/.exec(spec.at);
    const raw = `${Date.parse(spec.at) / 1000} ${zone ? `${zone[1]}${zone[2]}${zone[3]}` : '+0000'}`;
    const parent = (index + 2).toString(16).padStart(40, '0');
    const id = commits.add(sha, spec.merge ? `${parent} ${'f'.repeat(40)}` : parent, name, email, raw);
    if (spec.files && !spec.merge) {
      lines.set(
        id,
        spec.files.map(([path, added, removed, oldPath]) => ({ path, added, removed, oldPath })),
      );
    }
    return id;
  });
  return { commits, lines, ids: Int32Array.from(ids) };
}

function stats(
  specs: readonly Spec[],
  query: Partial<AggregateQuery> = {},
  options: { calendar?: DayCalendar; lineLimit?: number } = {},
) {
  const { commits, lines, ids } = build(specs);
  const calendar = options.calendar ?? UTC;
  const lineLimit = options.lineLimit ?? 100;
  const scope = prepareScope(commits, ids, calendar, lineLimit);
  return aggregateStats(
    { commits, lines, scope, calendar, lineLimit },
    { range: 'all', sort: 'commits', hotspots: 'files', contributors: 10, files: 10, now: NOW, ...query },
  );
}

const ALICE = 'Alice Archer <alice@x.dev>';
const HISTORY: readonly Spec[] = [
  { author: 'Carol Chen <carol@x.dev>', at: '2024-06-10T09:30:00+02:00', files: [['src/theme.ts', 10, 0]] },
  { author: ALICE, at: '2024-06-01T12:00:00Z', merge: true },
  {
    author: 'Bob Builder <bob@x.dev>',
    at: '2024-05-20T23:30:00-08:00',
    files: [
      ['src/forecast.ts', 4, 2],
      ['package.json', 1, 1],
    ],
  },
  // The same person, another email and other capitals.
  {
    author: 'alice archer <alice@home.dev>',
    at: '2024-05-02T10:00:00+05:30',
    files: [['src/new-name.ts', 2, 1, 'src/old-name.ts']],
  },
  {
    author: ALICE,
    at: '2024-03-04T08:15:00Z',
    files: [
      ['src/old-name.ts', 20, 0],
      ['logo.png', undefined, undefined],
    ],
  },
  { author: 'Dan Dubois <dan@x.dev>', at: '2024-01-02T10:00:00Z', files: [['README.md', 3, 0]] },
];

const at = (iso: string) => Date.parse(iso) / 1000;

describe('statistics aggregation', () => {
  it('sums up the commits: merges count as commits, not as lines', () => {
    const result = stats(HISTORY);
    expect(result.scopeCommits).toBe(6);
    expect(result.summary).toEqual({
      commits: 6,
      merges: 1,
      contributors: 4,
      added: 40,
      removed: 4,
      // The renamed file is one file; the binary one counts as changed.
      files: 6,
      activeDays: 6,
      first: at('2024-01-02T10:00:00Z'),
      last: at('2024-06-10T09:30:00+02:00'),
      // Lines per commit: 3, 3, 8, 10, 20.
      medianLines: 8,
    });
    expect(result.lines).toEqual({
      counted: 5,
      total: 5,
      limit: 100,
      all: false,
      scopeTotal: 5,
      pending: false,
    });
    expect(result.activity.linesFrom).toBeUndefined();
  });

  it('takes the middle of two for the median of an even count', () => {
    // Lines per commit: 3, 8, 10, 20.
    expect(stats(HISTORY.slice(0, 5)).summary.medianLines).toBe(9);
  });

  it('lists contributors with their share, lines, first and last commit and active days', () => {
    const { contributors } = stats(HISTORY);
    expect(contributors.total).toBe(4);
    expect(contributors.rows.map((row) => [row.name, row.commits])).toEqual([
      ['Alice Archer', 3],
      ['Carol Chen', 1],
      ['Bob Builder', 1],
      ['Dan Dubois', 1],
    ]);
    expect(contributors.rows[0]).toEqual({
      author: 'Alice Archer',
      name: 'Alice Archer',
      email: 'alice@x.dev',
      emails: ['alice@x.dev', 'alice@home.dev'],
      commits: 3,
      share: 0.5,
      added: 22,
      removed: 1,
      // Her merge has no lines of its own.
      countable: 2,
      counted: 2,
      counting: 0,
      first: at('2024-03-04T08:15:00Z'),
      last: at('2024-06-01T12:00:00Z'),
      activeDays: 3,
    });
  });

  it('orders contributors by lines or by their latest commit, and lists as many as asked', () => {
    const names = (query: Partial<AggregateQuery>) =>
      stats(HISTORY, query).contributors.rows.map((row) => row.name);
    expect(names({ sort: 'lines' })).toEqual(['Alice Archer', 'Carol Chen', 'Bob Builder', 'Dan Dubois']);
    expect(names({ sort: 'recent' })).toEqual(['Carol Chen', 'Alice Archer', 'Bob Builder', 'Dan Dubois']);
    const limited = stats(HISTORY, { contributors: 2 }).contributors;
    expect([limited.rows.length, limited.total]).toEqual([2, 4]);
  });

  it('filters to an author, whatever the case of the name, and keeps every contributor listed', () => {
    for (const author of ['Alice Archer', 'ALICE  archer']) {
      const result = stats(HISTORY, { author });
      expect(result.summary).toMatchObject({
        commits: 3,
        merges: 1,
        contributors: 1,
        added: 22,
        removed: 1,
        files: 2,
      });
      expect(result.contributors.total).toBe(4);
      expect(result.author).toMatchObject({ name: 'Alice Archer', commits: 3, share: 0.5 });
      expect(result.hotspots.rows.map((row) => row.path)).toEqual(['src/new-name.ts', 'logo.png']);
    }
    const nobody = stats(HISTORY, { author: 'Nobody' });
    expect(nobody.summary.commits).toBe(0);
    expect(nobody.author).toBeUndefined();
    expect(nobody.contributors.total).toBe(4);
  });

  it('describes an author: busiest weekday and hours in their own time zone', () => {
    const result = stats(
      [
        { author: 'Carol Chen <c@x>', at: '2024-06-04T10:15:00+02:00', files: [] },
        { author: 'Bob Builder <b@x>', at: '2024-06-03T15:00:00Z', files: [] },
        { author: 'Carol Chen <c@x>', at: '2024-05-29T10:05:00+02:00', files: [] },
        { author: 'Carol Chen <c@x>', at: '2024-05-28T11:40:00+02:00', files: [] },
      ],
      { author: 'Carol Chen' },
    );
    expect(result.author).toMatchObject({
      commits: 3,
      share: 0.75,
      weekday: 1,
      hours: [10, 12],
      activeDays: 3,
    });
  });

  it('names no busiest weekday when none stands out, nor hours that hold few commits', () => {
    const spread = ['2024-06-03', '2024-06-04', '2024-06-05', '2024-06-06'].map((day) => ({
      author: 'Carol Chen <c@x>',
      at: `${day}T10:00:00Z`,
      files: [],
    }));
    expect(stats(spread, { author: 'Carol Chen' }).author).toMatchObject({
      weekday: undefined,
      hours: [10, 12],
    });
    const scattered = [0, 3, 6, 9, 12, 15, 18, 21].map((hour) => ({
      author: 'Carol Chen <c@x>',
      at: `2024-06-0${(hour % 7) + 1}T${String(hour).padStart(2, '0')}:00:00Z`,
      files: [],
    }));
    expect(stats(scattered, { author: 'Carol Chen' }).author?.hours).toBeUndefined();
  });

  it('groups authors without a name by email, and unicode names whatever their case', () => {
    const result = stats([
      { author: '<bot@ci.dev>', at: '2024-06-02T10:00:00Z', files: [] },
      { author: 'ZOË ÅNGSTRÖM 🚀 <z@x>', at: '2024-06-01T10:00:00Z', files: [] },
      { author: 'Zoë Ångström 🚀 <zoe@x>', at: '2024-05-01T10:00:00Z', files: [] },
    ]);
    expect(result.contributors.rows.map((row) => [row.author, row.name, row.commits])).toEqual([
      ['ZOË ÅNGSTRÖM 🚀', 'ZOË ÅNGSTRÖM 🚀', 2],
      ['<bot@ci.dev>', 'bot@ci.dev', 1],
    ]);
    expect(
      stats([{ author: '<bot@ci.dev>', at: '2024-06-02T10:00:00Z' }], { author: '<bot@ci.dev>' }).summary
        .commits,
    ).toBe(1);
  });

  it('counts only the range: the last 30 days, 3 months, 12 months', () => {
    const commits = (range: AggregateQuery['range']) => stats(HISTORY, { range }).summary.commits;
    expect(commits('30d')).toBe(3);
    expect(commits('3m')).toBe(4);
    expect(commits('12m')).toBe(6);
    const empty = stats(HISTORY, { range: '30d', now: at('2025-01-01T00:00:00Z') });
    expect(empty.summary).toMatchObject({ commits: 0, contributors: 0, first: undefined, last: undefined });
    expect(empty.contributors.total).toBe(0);
    // Shares are of the range's commits.
    expect(stats(HISTORY, { range: '30d' }).contributors.rows.map((row) => row.share)).toEqual([
      1 / 3,
      1 / 3,
      1 / 3,
    ]);
  });

  it('starts ranges on the right day, month ends included', () => {
    const day = (y: number, m: number, d: number) => daysFromCivil(y, m, d);
    expect(isoDate(rangeStartDay('30d', day(2024, 6, 15)))).toBe('2024-05-17');
    expect(isoDate(rangeStartDay('3m', day(2024, 6, 15)))).toBe('2024-03-16');
    expect(isoDate(rangeStartDay('3m', day(2024, 5, 31)))).toBe('2024-03-01');
    expect(isoDate(rangeStartDay('3m', day(2024, 3, 31)))).toBe('2024-01-01');
    expect(isoDate(rangeStartDay('12m', day(2024, 2, 29)))).toBe('2023-03-01');
    expect(isoDate(rangeStartDay('12m', day(2024, 6, 15)))).toBe('2023-06-16');
    expect(rangeStartDay('all', day(2024, 6, 15))).toBe(-Infinity);
  });

  it('charts activity in periods that fit the span, lines included', () => {
    const { activity } = stats(HISTORY);
    expect(activity.unit).toBe('week');
    expect(activity.buckets).toHaveLength(24);
    expect(activity.buckets[0]).toMatchObject({
      start: '2024-01-01',
      end: '2024-01-07',
      commits: 1,
      added: 3,
    });
    expect(activity.buckets.at(-1)).toEqual({
      start: '2024-06-10',
      end: '2024-06-16',
      commits: 1,
      added: 10,
      removed: 0,
    });
    expect(activity.buckets.reduce((sum, bucket) => sum + bucket.commits, 0)).toBe(6);
    const month = stats(HISTORY, { range: '30d' }).activity;
    expect(month.unit).toBe('day');
    expect(month.buckets.map((bucket) => bucket.start)).toHaveLength(30);
    expect([month.buckets[0]!.start, month.buckets.at(-1)!.end]).toEqual(['2024-05-17', '2024-06-15']);
    expect(month.buckets.find((bucket) => bucket.start === '2024-05-21')?.commits).toBe(1);
  });

  it('counts days in the viewer’s calendar', () => {
    // 05:00Z on March 10th is still March 9th in Los Angeles.
    const specs: Spec[] = [
      { author: ALICE, at: '2024-03-10T05:00:00Z', files: [] },
      { author: ALICE, at: '2024-03-09T20:00:00Z', files: [] },
    ];
    const query = { range: '30d', now: at('2024-03-20T12:00:00Z') } as const;
    expect(stats(specs, query).summary.activeDays).toBe(2);
    const losAngeles = stats(specs, query, { calendar: new ZoneCalendar('America/Los_Angeles') });
    expect(losAngeles.summary.activeDays).toBe(1);
    expect(losAngeles.activity.buckets.find((bucket) => bucket.commits > 0)).toMatchObject({
      start: '2024-03-09',
      commits: 2,
    });
  });

  it('fills the punch card by weekday and hour where each commit was made', () => {
    const { punchCard } = stats(HISTORY);
    expect(punchCard).toHaveLength(168);
    const cell = (weekday: number, hour: number) => punchCard[weekday * 24 + hour];
    // Monday 23:30 in -08:00 (Tuesday 07:30 in UTC).
    expect(cell(0, 23)).toBe(1);
    expect(cell(1, 7)).toBe(0);
    // Thursday 10:00 in +05:30; Monday 09:30 in +02:00; Saturday noon; Monday 08:15; Tuesday 10:00.
    expect([cell(3, 10), cell(0, 9), cell(5, 12), cell(0, 8), cell(1, 10)]).toEqual([1, 1, 1, 1, 1]);
    expect(punchCard.reduce((sum, value) => sum + value, 0)).toBe(6);
  });

  it('finds hotspots per file, following renames, and per top-level folder', () => {
    const files = stats(HISTORY).hotspots;
    expect(files.total).toBe(6);
    expect(files.rows).toEqual([
      { path: 'src/new-name.ts', commits: 2, added: 22, removed: 1, authors: 1 },
      { path: 'src/theme.ts', commits: 1, added: 10, removed: 0, authors: 1 },
      { path: 'src/forecast.ts', commits: 1, added: 4, removed: 2, authors: 1 },
      { path: 'README.md', commits: 1, added: 3, removed: 0, authors: 1 },
      { path: 'package.json', commits: 1, added: 1, removed: 1, authors: 1 },
      { path: 'logo.png', commits: 1, added: 0, removed: 0, authors: 1 },
    ]);
    expect(stats(HISTORY, { files: 2 }).hotspots.rows).toHaveLength(2);
    const folders = stats(HISTORY, { hotspots: 'folders' }).hotspots;
    expect(folders).toEqual({
      total: 2,
      rows: [
        { path: 'src', commits: 4, added: 36, removed: 3, authors: 3 },
        { path: '', commits: 3, added: 4, removed: 1, authors: 3 },
      ],
    });
  });

  it('counts lines for the newest commits only, and says where counting stops', () => {
    const result = stats(HISTORY, {}, { lineLimit: 2 });
    expect(result.lines).toEqual({
      counted: 2,
      total: 5,
      limit: 2,
      all: false,
      scopeTotal: 5,
      pending: false,
    });
    expect(result.summary).toMatchObject({ commits: 6, added: 15, removed: 3, files: 3 });
    // Lines are known from the week of the first commit not counted (April 29th) on.
    expect(result.activity.buckets[result.activity.linesFrom!]!.start).toBe('2024-04-29');
    // Contributors' lines come from counted commits only, and say so.
    const rows = new Map(result.contributors.rows.map((row) => [row.name, row]));
    expect(rows.get('Alice Archer')).toMatchObject({
      added: 0,
      commits: 3,
      countable: 2,
      counted: 0,
      counting: 0,
    });
    expect(rows.get('Carol Chen')).toMatchObject({ added: 10, countable: 1, counted: 1, counting: 0 });
    expect(rows.get('Dan Dubois')).toMatchObject({ countable: 1, counted: 0, counting: 0 });
  });

  it('counts every commit’s lines when the scope is prepared without a limit', () => {
    const { commits, lines, ids } = build(HISTORY);
    const scope = prepareScope(commits, ids, UTC, Infinity);
    expect([scope.linesEnd, scope.nonMerges]).toEqual([6, 5]);
    const result = aggregateStats(
      { commits, lines, scope, calendar: UTC, lineLimit: 2, allLines: true },
      { range: 'all', sort: 'commits', hotspots: 'files', contributors: 10, files: 10, now: NOW },
    );
    expect(result.lines).toEqual({
      counted: 5,
      total: 5,
      limit: 2,
      all: true,
      scopeTotal: 5,
      pending: false,
    });
    expect(result.summary).toMatchObject({ added: 40, removed: 4 });
    // A window of two ends after the second commit that is not a merge.
    expect(prepareScope(commits, ids, UTC, 2)).toMatchObject({ linesEnd: 3, nonMerges: 5 });
  });

  it('tells a contributor’s lines still to come from lines not counted at all', () => {
    // Alice's newest commit is in the window, its lines not read yet.
    const result = stats([{ author: ALICE, at: '2024-06-12T10:00:00Z' }, ...HISTORY], {}, { lineLimit: 3 });
    const alice = result.contributors.rows.find((row) => row.name === 'Alice Archer');
    expect(alice).toMatchObject({ commits: 4, countable: 3, counted: 0, counting: 1 });
    // A contributor with merges only has nothing to count.
    const merger = stats([
      { author: 'Merge Bot <bot@x.dev>', at: '2024-06-12T10:00:00Z', merge: true },
      ...HISTORY,
    ]).contributors.rows.find((row) => row.name === 'Merge Bot');
    expect(merger).toMatchObject({ commits: 1, countable: 0, counted: 0, counting: 0, added: 0 });
  });

  it('says when lines are still being counted', () => {
    const pending = stats([{ author: ALICE, at: '2024-06-12T10:00:00Z' }, ...HISTORY]);
    expect(pending.lines).toEqual({
      counted: 5,
      total: 6,
      limit: 100,
      all: false,
      scopeTotal: 6,
      pending: true,
    });
    expect(pending.contributors.rows[0]).toMatchObject({ name: 'Alice Archer', counted: 2, counting: 1 });
    expect(pending.activity.buckets[pending.activity.linesFrom!]!.start).toBe('2024-06-10');
  });

  it('can reuse the commit totals while lines change', () => {
    const { commits, lines, ids } = build(HISTORY);
    const scope = prepareScope(commits, ids, UTC, 100);
    const input = { commits, lines, scope, calendar: UTC, lineLimit: 100 };
    const query = {
      range: 'all',
      sort: 'lines',
      hotspots: 'files',
      contributors: 10,
      files: 10,
      now: NOW,
    } as const;
    const totals = countCommits(input, 'all', undefined, NOW);
    expect(aggregateStats(input, query, totals)).toEqual(aggregateStats(input, query));
  });

  it('handles a scope without commits', () => {
    const result = stats([]);
    expect(result.scopeCommits).toBe(0);
    expect(result.summary).toMatchObject({ commits: 0, files: 0, activeDays: 0, medianLines: undefined });
    expect(result.activity.buckets).toEqual([]);
    expect(result.hotspots).toEqual({ total: 0, rows: [] });
  });
});
