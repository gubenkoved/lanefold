import { describe, expect, it } from 'vitest';
import {
  activityUnit,
  civilFromDays,
  daysFromCivil,
  isoDate,
  periodDays,
  periodOf,
  weekdayOf,
  ZoneCalendar,
} from '../../src/core/stats/calendar';
import { languageOf, parseTree, summarizeLanguages } from '../../src/core/stats/languages';
import { parseRawDate, StatsLogParser, type LogRecord } from '../../src/core/stats/parse';
import { checkStatsQuery, checkStatsScope } from '../../src/core/stats/repoStats';
import { CommitStore, LineStore, personKey } from '../../src/core/stats/store';
import { authorSearch, isStatsConfig, periodSearch, spanInWords, statsConfig } from '../../src/shared/stats';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

/** `git log -z` output as git writes it: RS, the fields, NUL after each (numstat after a newline). */
function record(sha: string, fields: readonly string[], numstat: readonly string[] = []): string {
  const header = `\x1e${[sha, ...fields].join('\0')}\0`;
  return numstat.length === 0 ? header : `${header}\n${numstat.join('\0')}\0`;
}

function parse(text: string, fieldCount: number, chunkSize?: number): LogRecord[] {
  const records: LogRecord[] = [];
  const parser = new StatsLogParser(fieldCount, (r) => records.push(r));
  const bytes = new TextEncoder().encode(text);
  if (chunkSize === undefined) parser.push(bytes);
  else for (let i = 0; i < bytes.length; i += chunkSize) parser.push(bytes.subarray(i, i + chunkSize));
  parser.end();
  return records;
}

describe('statistics log parser', () => {
  const metadata = [
    record(A, [`${B} ${C}`, 'Zoë Ångström 🚀', 'zoe@example.com', '1700000000 +0530']),
    record(B, [C, '山田 太郎', 'taro@example.jp', '1699990000 -0800']),
    record(C, ['', 'Alice', 'alice@example.com', '1699900000 +0000']),
  ].join('');

  it('reads commit metadata: merges, unicode names, root commits', () => {
    expect(parse(metadata, 4)).toEqual([
      { sha: A, fields: [`${B} ${C}`, 'Zoë Ångström 🚀', 'zoe@example.com', '1700000000 +0530'], files: [] },
      { sha: B, fields: [C, '山田 太郎', 'taro@example.jp', '1699990000 -0800'], files: [] },
      { sha: C, fields: ['', 'Alice', 'alice@example.com', '1699900000 +0000'], files: [] },
    ]);
  });

  it('gives the same records however the output is cut into chunks', () => {
    const whole = parse(metadata, 4);
    // Cuts fall inside multi-byte characters, between NULs and RS bytes.
    for (const size of [1, 2, 3, 5, 7, 13, 64]) expect(parse(metadata, 4, size)).toEqual(whole);
  });

  it('reads numstat: renames in the -z form, binary files, merges and empty commits without files', () => {
    const text = [
      record(A, [], ['3\t1\tsrc/app.ts', '-\t-\tlogo.png', '10\t0\tdocs/a\tb.md']),
      record(B, [], ['2\t2\t', 'old/name.ts', 'new/name.ts', '-\t-\t', 'img/a.png', 'img/b.png']),
      record(C, []),
      record(D, [], ['0\t5\tgone.txt']),
    ].join('');
    const expected: LogRecord[] = [
      {
        sha: A,
        fields: [],
        files: [
          { path: 'src/app.ts', added: 3, removed: 1 },
          { path: 'logo.png', added: undefined, removed: undefined },
          { path: 'docs/a\tb.md', added: 10, removed: 0 },
        ],
      },
      {
        sha: B,
        fields: [],
        files: [
          { path: 'new/name.ts', oldPath: 'old/name.ts', added: 2, removed: 2 },
          { path: 'img/b.png', oldPath: 'img/a.png', added: undefined, removed: undefined },
        ],
      },
      { sha: C, fields: [], files: [] },
      { sha: D, fields: [], files: [{ path: 'gone.txt', added: 0, removed: 5 }] },
    ];
    expect(parse(text, 0)).toEqual(expected);
    for (const size of [1, 4, 9]) expect(parse(text, 0, size)).toEqual(expected);
  });

  it('reads metadata and numstat together, with fields that look like separators', () => {
    const text = record(A, ['', '\x1eodd name', 'x@y', '1 +0000'], ['1\t0\t\x1estrange path']);
    expect(parse(text, 4)).toEqual([
      {
        sha: A,
        fields: ['', '\x1eodd name', 'x@y', '1 +0000'],
        files: [{ path: '\x1estrange path', added: 1, removed: 0 }],
      },
    ]);
  });

  it('reads nothing from empty output', () => {
    expect(parse('', 4)).toEqual([]);
    expect(parse('', 0, 1)).toEqual([]);
  });

  it('reads raw dates with their offsets', () => {
    expect(parseRawDate('1700000000 +0530')).toEqual({ time: 1700000000, offset: 330 });
    expect(parseRawDate('1700000000 -0800')).toEqual({ time: 1700000000, offset: -480 });
    expect(parseRawDate('1700000000 +0000')).toEqual({ time: 1700000000, offset: 0 });
    expect(parseRawDate('1700000000 -0330')).toEqual({ time: 1700000000, offset: -210 });
    expect(parseRawDate('garbage')).toEqual({ time: 0, offset: 0 });
  });
});

describe('statistics stores', () => {
  it('groups authors by name, whatever its case and spacing, or by email without one', () => {
    expect(personKey('Carol  Chen ', 'carol@x.dev')).toBe('carol chen');
    expect(personKey('CAROL CHEN', 'other@x.dev')).toBe('carol chen');
    // Composed and decomposed forms of the same name are one person.
    expect(personKey('Zoë', 'z@x')).toBe(personKey('Zoë', 'z@x'));
    expect(personKey('', 'Bot@CI.dev ')).toBe('<bot@ci.dev>');
  });

  it('numbers commits densely and gives their hashes back', () => {
    const store = new CommitStore();
    const a = store.add(A, '', 'Alice', 'alice@x', '100 +0100');
    const b = store.add(B, `${A} ${C}`, 'alice', 'alice@home', '200 -0230');
    expect([a, b]).toEqual([0, 1]);
    expect(store.id(A)).toBe(a);
    expect(store.sha(b)).toBe(B);
    expect(store.isMerge(b)).toBe(true);
    expect(store.isMerge(a)).toBe(false);
    expect([store.offset[a], store.offset[b], store.time[b]]).toEqual([60, -150, 200]);
    expect(store.personOf(a)).toBe(store.personOf(b));
    expect(store.identities.map((identity) => identity.email)).toEqual(['alice@x', 'alice@home']);
    expect(store.id('not a hash')).toBe(-1);
    expect(store.id('g'.repeat(40))).toBe(-1);
  });

  it('keeps a commit’s files compactly, and forgets commits it no longer needs', () => {
    const lines = new LineStore();
    lines.set(0, [
      { path: 'a.ts', added: 3, removed: 1 },
      { path: 'b.ts', oldPath: 'a-old.ts', added: 2, removed: 0 },
      { path: 'logo.png' },
    ]);
    lines.set(1, []);
    const first = lines.get(0)!;
    expect([first.added, first.removed]).toEqual([5, 1]);
    expect(Array.from(first.files)).toEqual([0, -1, 3, 1, 1, 2, 2, 0, 3, -1, -1, -1]);
    expect(lines.paths).toEqual(['a.ts', 'b.ts', 'a-old.ts', 'logo.png']);
    expect(lines.get(1)!.files.length).toBe(0);
    lines.trim(5, () => false);
    expect(lines.size).toBe(2);
    lines.trim(1, (id) => id === 1);
    expect([lines.has(0), lines.has(1)]).toEqual([false, true]);
  });
});

describe('statistics calendar', () => {
  it('converts day numbers and dates both ways', () => {
    expect(civilFromDays(0)).toEqual({ year: 1970, month: 1, day: 1 });
    expect(daysFromCivil(2024, 2, 29)).toBe(19_782);
    expect(isoDate(19_782)).toBe('2024-02-29');
    for (const day of [-1000, 0, 11_016, 19_782, 30_000]) {
      const { year, month, day: date } = civilFromDays(day);
      expect(daysFromCivil(year, month, date)).toBe(day);
    }
    // 1970-01-01 was a Thursday; Monday is 0.
    expect([weekdayOf(0), weekdayOf(4), weekdayOf(-3)]).toEqual([3, 0, 0]);
  });

  it('numbers periods, weeks starting on Monday', () => {
    const monday = daysFromCivil(2024, 3, 4);
    expect(periodOf('week', monday)).toBe(periodOf('week', monday + 6));
    expect(periodOf('week', monday - 1)).toBe(periodOf('week', monday) - 1);
    expect(periodDays('week', periodOf('week', monday + 3)).map(isoDate)).toEqual([
      '2024-03-04',
      '2024-03-10',
    ]);
    expect(periodDays('month', periodOf('month', daysFromCivil(2024, 2, 10))).map(isoDate)).toEqual([
      '2024-02-01',
      '2024-02-29',
    ]);
    expect(periodDays('quarter', periodOf('quarter', daysFromCivil(2024, 5, 31))).map(isoDate)).toEqual([
      '2024-04-01',
      '2024-06-30',
    ]);
    expect(periodDays('year', 2023).map(isoDate)).toEqual(['2023-01-01', '2023-12-31']);
    expect(
      periodOf('month', daysFromCivil(2025, 1, 1)) - periodOf('month', daysFromCivil(2024, 12, 31)),
    ).toBe(1);
  });

  it('chooses periods so the chart has about 20 to 80 bars', () => {
    const start = daysFromCivil(2024, 1, 1);
    expect(activityUnit(start, start)).toBe('day');
    expect(activityUnit(start, start + 29)).toBe('day');
    // 91 days: 91 days are nearer to 80 than 13 weeks are to 20.
    expect(activityUnit(start, start + 90)).toBe('day');
    expect(activityUnit(start, start + 159)).toBe('week');
    expect(activityUnit(start, daysFromCivil(2025, 12, 31))).toBe('month');
    expect(activityUnit(start, daysFromCivil(2033, 12, 31))).toBe('quarter');
    expect(activityUnit(start, daysFromCivil(2063, 12, 31))).toBe('year');
  });

  it('puts times on the days of a time zone, daylight saving time included', () => {
    const newYork = new ZoneCalendar('America/New_York');
    expect(newYork.timeZone).toBe('America/New_York');
    // 2024-03-10 06:59Z is 01:59 EST; 07:00Z is 03:00 EDT (the clocks went forward).
    expect(newYork.offsetAt(Date.UTC(2024, 2, 10, 6, 59) / 1000)).toBe(-300);
    expect(newYork.offsetAt(Date.UTC(2024, 2, 10, 7, 0) / 1000)).toBe(-240);
    expect(newYork.offsetAt(Date.UTC(2024, 6, 1) / 1000)).toBe(-240);
    // 03:30Z on March 11th is still March 10th in New York.
    expect(isoDate(newYork.dayOf(Date.UTC(2024, 2, 11, 3, 30) / 1000))).toBe('2024-03-10');
    expect(isoDate(new ZoneCalendar('Asia/Kolkata').dayOf(Date.UTC(2024, 2, 10, 19, 0) / 1000))).toBe(
      '2024-03-11',
    );
    expect(new ZoneCalendar('UTC').dayOf(Date.UTC(2024, 2, 10, 23, 59) / 1000)).toBe(
      daysFromCivil(2024, 3, 10),
    );
  });

  it('falls back to a zone it knows for one it does not', () => {
    const calendar = new ZoneCalendar('Not/AZone');
    expect(calendar.timeZone).not.toBe('Not/AZone');
    expect(Number.isFinite(calendar.dayOf(1_700_000_000))).toBe(true);
  });
});

describe('languages', () => {
  it('names languages from extensions and well-known file names', () => {
    expect(languageOf('src/app.tsx')).toBe('TypeScript');
    expect(languageOf('types/index.d.ts')).toBe('TypeScript');
    expect(languageOf('lib/x.MJS')).toBe('JavaScript');
    expect(languageOf('docs/README.md')).toBe('Markdown');
    expect(languageOf('Dockerfile')).toBe('Dockerfile');
    expect(languageOf('build/Dockerfile.dev')).toBe('Dockerfile');
    expect(languageOf('Makefile')).toBe('Makefile');
    expect(languageOf('CMakeLists.txt')).toBe('CMake');
    expect(languageOf('LICENSE')).toBeUndefined();
    expect(languageOf('.gitignore')).toBeUndefined();
    expect(languageOf('image.png')).toBeUndefined();
  });

  it('reads files and their sizes from ls-tree, without links and submodules', () => {
    const output = [
      `100644 blob ${A}     120\tsrc/a.ts`,
      `100755 blob ${B}      40\tbin/run.sh`,
      `120000 blob ${C}      10\tlink.ts`,
      `160000 commit ${D}       -\tvendor/lib`,
      `100644 blob ${A}       7\tdocs/with\ttab.md`,
      '',
    ].join('\0');
    expect(parseTree(output)).toEqual([
      { path: 'src/a.ts', bytes: 120 },
      { path: 'bin/run.sh', bytes: 40 },
      { path: 'docs/with\ttab.md', bytes: 7 },
    ]);
  });

  it('ranks languages by size and folds the smallest into Other', () => {
    const files = [
      { path: 'a.ts', bytes: 1000 },
      { path: 'b.ts', bytes: 500 },
      { path: 'c.py', bytes: 900 },
      { path: 'README.md', bytes: 100 },
      { path: 'LICENSE', bytes: 50 },
      ...['go', 'rs', 'rb', 'php', 'java', 'kt'].map((ext, i) => ({ path: `x.${ext}`, bytes: 10 + i })),
    ];
    const stats = summarizeLanguages(files);
    expect(stats.files).toBe(11);
    expect(stats.bytes).toBe(2625);
    expect(stats.languages.map((l) => l.language)).toEqual([
      'TypeScript',
      'Python',
      'Markdown',
      'Kotlin',
      'Java',
      'PHP',
      'Ruby',
      'Other',
    ]);
    expect(stats.languages[0]).toEqual({ language: 'TypeScript', files: 2, bytes: 1500 });
    // LICENSE (unknown), Rust and Go (the smallest).
    expect(stats.languages.at(-1)).toEqual({ language: 'Other', files: 3, bytes: 50 + 11 + 10 });
  });
});

describe('statistics requests', () => {
  const valid = { repoId: '/r', scope: 'head', range: 'all', sort: 'commits', hotspots: 'files' };

  it('accepts what the view sends, with limits kept sensible', () => {
    expect(
      checkStatsQuery({
        ...valid,
        author: 'Carol Chen',
        contributors: 25.7,
        files: 99_999,
        timeZone: 'Europe/Berlin',
      }),
    ).toEqual({
      scope: 'head',
      range: 'all',
      author: 'Carol Chen',
      sort: 'commits',
      hotspots: 'files',
      contributors: 25,
      files: 1000,
      timeZone: 'Europe/Berlin',
      refresh: false,
    });
    expect(checkStatsQuery({ ...valid, refresh: true }).refresh).toBe(true);
    expect(checkStatsQuery({ ...valid, refresh: 'yes' }).refresh).toBe(false);
    expect(checkStatsQuery({ ...valid, contributors: -3 }).contributors).toBe(1);
    expect(checkStatsQuery(valid).files).toBe(10);
    expect(checkStatsQuery({ ...valid, timeZone: '../../etc' }).timeZone).toBeUndefined();
    expect(checkStatsScope('all')).toBe('all');
  });

  it('refuses anything else', () => {
    expect(() => checkStatsQuery({ ...valid, scope: 'everything' })).toThrow(/scope/);
    expect(() => checkStatsQuery({ ...valid, range: '1y' })).toThrow(/range/);
    expect(() => checkStatsQuery({ ...valid, sort: 'name' })).toThrow(/order/);
    expect(() => checkStatsQuery({ ...valid, hotspots: 'lines' })).toThrow(/grouping/);
    expect(() => checkStatsQuery({ ...valid, author: 'x'.repeat(300) })).toThrow(/author/);
    expect(() => checkStatsQuery({ ...valid, author: 'a\nb' })).toThrow(/author/);
    expect(() => checkStatsQuery({ ...valid, author: 42 })).toThrow(/author/);
    expect(() => checkStatsQuery(undefined)).toThrow(/scope/);
    expect(() => checkStatsScope('refs')).toThrow(/scope/);
  });
});

describe('statistics view helpers', () => {
  const at = (date: string) => Date.parse(date) / 1000;

  it('says how long a span is', () => {
    expect(spanInWords(at('2022-03-10T12:00'), at('2024-06-12T12:00'))).toBe('2 years, 3 months');
    expect(spanInWords(at('2023-01-05T12:00'), at('2024-01-05T12:00'))).toBe('1 year');
    expect(spanInWords(at('2024-01-02T12:00'), at('2024-06-10T12:00'))).toBe('5 months');
    expect(spanInWords(at('2024-01-31T12:00'), at('2024-02-29T12:00'))).toBe('29 days');
    expect(spanInWords(at('2024-03-01T09:00'), at('2024-03-02T08:00'))).toBe('1 day');
    expect(spanInWords(at('2024-03-01T09:00'), at('2024-03-01T18:00'))).toBe('a single day');
  });

  it('searches the log for an author or a period', () => {
    expect(authorSearch('carol')).toBe('@carol');
    expect(authorSearch('Carol Chen')).toBe('author:"Carol Chen"');
    expect(authorSearch('Jo "JJ" Doe')).toBe('author:"Jo JJ Doe"');
    expect(authorSearch('<bot@ci.dev>')).toBe('@bot@ci.dev');
    expect(periodSearch('2024-03-01', '2024-03-31')).toBe(
      'after:"2024-03-01 00:00:00" before:"2024-03-31 23:59:59"',
    );
  });

  it('restores saved configs: valid fields kept, the rest defaulted', () => {
    expect(isStatsConfig({ scope: 'all', range: '30d', author: 'Carol Chen' })).toBe(true);
    expect(isStatsConfig({})).toBe(true);
    expect(isStatsConfig({ scope: 'local' })).toBe(false);
    expect(isStatsConfig({ author: '' })).toBe(false);
    expect(isStatsConfig(null)).toBe(false);
    expect(statsConfig({ range: '3m' })).toEqual({
      scope: 'head',
      range: '3m',
      sort: 'commits',
      hotspots: 'files',
      activity: 'commits',
    });
  });
});
