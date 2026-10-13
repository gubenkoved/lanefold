/**
 * Builds a realistic demo repository ("aurora") for the harness, screenshots and e2e tests:
 * several authors, feature branches (merged and open), a hotfix, annotated tags, a remote with
 * an extra remote-only branch, and uncommitted changes. Hashes are deterministic.
 *
 *   node out/harness/make-demo-repo.mjs <target-dir>
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TestRepo, type Identity } from '../../test/fixtures/repoBuilder';

const ALICE: Identity = { name: 'Alice Archer', email: 'alice@aurora.dev' };
const BOB: Identity = { name: 'Bob Builder', email: 'bob@aurora.dev' };
const CAROL: Identity = { name: 'Carol Chen', email: 'carol@aurora.dev' };
const DAN: Identity = { name: 'Dan Dubois', email: 'dan@aurora.dev' };

/** A source file that evolves through several commits, for blame and file history. */
const FORECAST = {
  first: `// Forecast API client for the Aurora dashboard.
const BASE_URL = 'https://api.aurora.dev/v1';

export interface Forecast {
  city: string;
  day: string;
  high: number;
  low: number;
  summary: string;
}

/** The calendar day of a forecast entry. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Fetches the five-day forecast for a city. */
export async function fetchForecast(city: string): Promise<Forecast[]> {
  const response = await fetch(\`\${BASE_URL}/forecast?city=\${encodeURIComponent(city)}\`);
  if (!response.ok) throw new Error(\`Forecast failed: \${response.status}\`);
  const days = (await response.json()) as Forecast[];
  return days.map((entry) => ({ ...entry, day: dayOf(entry.day) }));
}

/** Formats a temperature for display. */
export function formatTemperature(value: number): string {
  return \`\${value}°\`;
}
`,
  cached: `// Forecast API client for the Aurora dashboard.
import { cache } from './cache';

const BASE_URL = 'https://api.aurora.dev/v1';

export interface Forecast {
  city: string;
  day: string;
  high: number;
  low: number;
  summary: string;
}

/** The calendar day of a forecast entry. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Fetches the five-day forecast for a city. */
export async function fetchForecast(city: string): Promise<Forecast[]> {
  const cached = cache.get(city);
  if (cached) return cached;
  const response = await fetch(\`\${BASE_URL}/forecast?city=\${encodeURIComponent(city)}\`);
  if (!response.ok) throw new Error(\`Forecast failed: \${response.status}\`);
  const days = (await response.json()) as Forecast[];
  const forecast = days.map((entry) => ({ ...entry, day: dayOf(entry.day) }));
  cache.set(city, forecast);
  return forecast;
}

/** Formats a temperature for display. */
export function formatTemperature(value: number): string {
  return \`\${value}°\`;
}
`,
  timezone: `// Forecast API client for the Aurora dashboard.
const BASE_URL = 'https://api.aurora.dev/v1';

export interface Forecast {
  city: string;
  day: string;
  high: number;
  low: number;
  summary: string;
}

/** The calendar day of a forecast entry. */
function dayOf(iso: string): string {
  // Forecast days are UTC midnights: read them in UTC, not in the browser's time zone.
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

/** Fetches the five-day forecast for a city. */
export async function fetchForecast(city: string): Promise<Forecast[]> {
  const response = await fetch(\`\${BASE_URL}/forecast?city=\${encodeURIComponent(city)}\`);
  if (!response.ok) throw new Error(\`Forecast failed: \${response.status}\`);
  const days = (await response.json()) as Forecast[];
  return days.map((entry) => ({ ...entry, day: dayOf(entry.day) }));
}

/** Formats a temperature for display. */
export function formatTemperature(value: number): string {
  return \`\${value}°\`;
}
`,
  merged: `// Forecast API client for the Aurora dashboard.
import { cache } from './cache';

const BASE_URL = 'https://api.aurora.dev/v1';

export interface Forecast {
  city: string;
  day: string;
  high: number;
  low: number;
  summary: string;
}

/** The calendar day of a forecast entry. */
function dayOf(iso: string): string {
  // Forecast days are UTC midnights: read them in UTC, not in the browser's time zone.
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

/** Fetches the five-day forecast for a city. */
export async function fetchForecast(city: string): Promise<Forecast[]> {
  const cached = cache.get(city);
  if (cached) return cached;
  const response = await fetch(\`\${BASE_URL}/forecast?city=\${encodeURIComponent(city)}\`);
  if (!response.ok) throw new Error(\`Forecast failed: \${response.status}\`);
  const days = (await response.json()) as Forecast[];
  const forecast = days.map((entry) => ({ ...entry, day: dayOf(entry.day) }));
  cache.set(city, forecast);
  return forecast;
}

/** Formats a temperature for display. */
export function formatTemperature(value: number): string {
  return \`\${value}°\`;
}
`,
  polished: `// Forecast API client for the Aurora dashboard.
import { cache } from './cache';

const BASE_URL = 'https://api.aurora.dev/v1';

export interface Forecast {
  city: string;
  day: string;
  high: number;
  low: number;
  summary: string;
}

/** The calendar day of a forecast entry. */
function dayOf(iso: string): string {
  // Forecast days are UTC midnights: read them in UTC, not in the browser's time zone.
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

/** Fetches the five-day forecast for a city. */
export async function fetchForecast(city: string): Promise<Forecast[]> {
  const cached = cache.get(city);
  if (cached) return cached;
  const response = await fetch(\`\${BASE_URL}/forecast?city=\${encodeURIComponent(city)}\`);
  if (!response.ok) throw new Error(\`Forecast failed: \${response.status}\`);
  const days = (await response.json()) as Forecast[];
  const forecast = days.map((entry) => ({ ...entry, day: dayOf(entry.day) }));
  cache.set(city, forecast);
  return forecast;
}

/** Formats a temperature for display. */
export function formatTemperature(value: number): string {
  return \`\${Math.round(value)}°\`;
}
`,
  v2: `// Forecast API client for the Aurora dashboard.
import { cache } from './cache';

const BASE_URL = 'https://api.aurora.dev/v2';

export interface Forecast {
  city: string;
  day: string;
  high: number;
  low: number;
  summary: string;
}

/** The calendar day of a forecast entry. */
function dayOf(iso: string): string {
  // Forecast days are UTC midnights: read them in UTC, not in the browser's time zone.
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'UTC' });
}

/** Fetches the five-day forecast for a city. */
export async function fetchForecast(city: string): Promise<Forecast[]> {
  const cached = cache.get(city);
  if (cached) return cached;
  const response = await fetch(\`\${BASE_URL}/forecast?city=\${encodeURIComponent(city)}\`);
  if (!response.ok) throw new Error(\`Forecast failed: \${response.status}\`);
  const days = (await response.json()) as Forecast[];
  const forecast = days.map((entry) => ({ ...entry, day: dayOf(entry.day) }));
  cache.set(city, forecast);
  return forecast;
}

/** Formats a temperature for display. */
export function formatTemperature(value: number): string {
  return \`\${Math.round(value)}°\`;
}
`,
};

export async function buildDemoRepo(): Promise<{ repo: TestRepo; remote: TestRepo }> {
  const remote = await TestRepo.create({ bare: true });
  const repo = await TestRepo.create();
  const c = (message: string, author: Identity, files: Record<string, string | null>) =>
    repo.commit(message, { author, files });

  // Dates spread over half a year, so blame and the graph show a real timeline.
  repo.at('2024-01-02');
  await c('Initial commit', ALICE, { 'README.md': '# Aurora\n\nA tiny weather dashboard.\n' });
  repo.at('2024-01-04');
  await c('Add project scaffolding', ALICE, {
    'package.json': '{ "name": "aurora" }\n',
    'src/index.ts': 'export {};\n',
  });
  repo.at('2024-01-09');
  await c('Set up CI pipeline', BOB, { '.github/workflows/ci.yml': 'on: push\n' });
  repo.at('2024-01-16');
  await c('Add forecast API client', ALICE, {
    'src/api.ts': 'export const fetchForecast = () => [];\n',
    'src/forecast.ts': FORECAST.first,
  });
  await repo.tag('v0.1.0', { message: 'First preview' });

  // A feature branch that gets merged with a merge commit.
  await repo.checkoutNew('feature/login');
  repo.at('2024-02-02');
  await c('Add login form component', CAROL, { 'src/login.tsx': 'export const Login = () => null;\n' });
  repo.at('2024-02-06');
  await c('Validate credentials on submit', CAROL, {
    'src/login.tsx': 'export const Login = () => "form";\n',
  });
  await repo.checkout('main');
  repo.at('2024-02-20');
  await c('Cache forecast responses', BOB, {
    'src/cache.ts': 'export const cache = new Map();\n',
    'src/forecast.ts': FORECAST.cached,
  });
  await repo.checkout('feature/login');
  repo.at('2024-02-22');
  await c('Remember the last signed-in user', CAROL, { 'src/session.ts': 'export const last = "";\n' });
  await repo.checkout('main');
  repo.at('2024-02-26');
  await repo.merge('feature/login', { noFF: true, message: "Merge branch 'feature/login'" });

  // A hotfix branched from the tag, merged back.
  await repo.checkoutNew('hotfix/timezone', 'v0.1.0');
  repo.at('2024-03-12');
  await c('Fix timezone offset in daily view', DAN, {
    'src/time.ts': 'export const tz = 0;\n',
    'src/forecast.ts': FORECAST.timezone,
  });
  await repo.checkout('main');
  repo.at('2024-03-13');
  await repo.merge('hotfix/timezone', { noFF: true, message: "Merge branch 'hotfix/timezone'" });
  repo.at('2024-04-02');
  await c('Polish dashboard layout', ALICE, {
    'src/dashboard.css': '.grid { display: grid; }\n',
    'src/forecast.ts': FORECAST.polished,
  });
  await repo.tag('v1.0.0', { message: 'Aurora 1.0' });

  // Open work: a search feature in progress, and an experiment off an older commit.
  await repo.checkoutNew('feature/search');
  repo.at('2024-04-19');
  await c('Add city search box', BOB, { 'src/search.tsx': 'export const Search = () => null;\n' });
  repo.at('2024-04-23');
  await c('Debounce search requests', BOB, {
    'src/search.tsx': 'export const Search = () => "debounced";\n',
  });
  repo.at('2024-05-03');
  await c('Show recent searches', CAROL, { 'src/recent.ts': 'export const recent: string[] = [];\n' });
  await repo.checkoutNew('experiment/maps', 'v0.1.0');
  repo.at('2024-04-25');
  await c('Prototype radar map layer', DAN, { 'src/map.ts': 'export const radar = true;\n' });
  repo.at('2024-04-29');
  await c('Try vector tiles', DAN, { 'src/map.ts': 'export const radar = "vector";\n' });
  await repo.checkout('main');
  repo.at('2024-05-20');
  await c('Update dependencies', BOB, {
    'package.json': '{ "name": "aurora", "version": "1.0.1" }\n',
    'src/forecast.ts': FORECAST.v2,
  });
  repo.at('2024-05-28');
  await c('Improve README', ALICE, { 'README.md': '# Aurora\n\nA tiny, fast weather dashboard.\n' });

  // Publish to the remote, then add a remote-only branch and an unpushed local commit.
  await repo.addRemote('origin', remote);
  await repo.git('push', '-q', 'origin', 'main', 'feature/search', '--tags');
  await repo.git('branch', '-q', '--set-upstream-to=origin/main', 'main');
  await repo.git('branch', '-q', '--set-upstream-to=origin/feature/search', 'feature/search');
  await repo.git('push', '-q', 'origin', 'experiment/maps:review/maps');
  repo.at('2024-06-10');
  await c('Add dark mode toggle', CAROL, { 'src/theme.ts': 'export const dark = true;\n' });

  // Uncommitted work in the tree.
  await repo.write('src/dashboard.css', '.grid { display: grid; gap: 8px; }\n');
  await repo.write('NOTES.md', 'Ideas: hourly chart, alerts\n');
  await repo.git('add', 'NOTES.md');
  return { repo, remote };
}

async function main(): Promise<void> {
  const target = resolve(process.argv[2] ?? 'out/demo');
  const { repo, remote } = await buildDemoRepo();
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(repo.path, join(target, 'aurora'), { recursive: true });
  await cp(remote.path, join(target, 'aurora-remote.git'), { recursive: true });
  // Point the copied repo at the copied remote.
  const copy = join(target, 'aurora');
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['-C', copy, 'remote', 'set-url', 'origin', join(target, 'aurora-remote.git')]);
  await repo.dispose();
  await remote.dispose();
  console.log(copy);
}

if (process.argv[1]?.includes('make-demo-repo')) void main();
