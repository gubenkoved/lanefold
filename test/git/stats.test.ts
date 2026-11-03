import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessPlatform } from '../../dev/harness/platform';
import { Backend } from '../../src/core/backend/backend';
import { ConsoleLog } from '../../src/core/console/consoleLog';
import type { GitCommandEnd } from '../../src/core/git/runner';
import { RepositoryRegistry } from '../../src/core/repo/registry';
import { Repository } from '../../src/core/repo/repository';
import { RepoStats, type CheckedQuery } from '../../src/core/stats/repoStats';
import { CommitStore } from '../../src/core/stats/store';
import type { RpcMessage, RpcTransport } from '../../src/shared/rpc';
import type { StatsProgress, StatsResult } from '../../src/shared/stats';
import { ALICE, BOB, TestRepo, type Identity } from '../fixtures/repoBuilder';

const CAROL: Identity = { name: 'Carol Chen', email: 'carol@x.dev' };
/** Carol's commits from before she set up her name: the mailmap says they are hers. */
const CAROL_OLD: Identity = { name: 'cc', email: 'cc@old.dev' };
const DAN: Identity = { name: 'Dan Dubois', email: 'dan@x.dev' };

const NOW = Date.parse('2024-02-01T12:00:00Z') / 1000;

function query(scope: 'head' | 'all', extra: Partial<CheckedQuery> = {}): CheckedQuery {
  return {
    scope,
    range: 'all',
    sort: 'commits',
    hotspots: 'files',
    contributors: 10,
    files: 10,
    timeZone: 'UTC',
    ...extra,
  };
}

/** Commits with a raw git date ("<seconds> <offset>") and author of its own. */
async function commitAt(
  test: TestRepo,
  message: string,
  date: string,
  author: Identity,
  files: Record<string, string> = {},
): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await test.write(file, content);
    await test.git('add', '--', file);
  }
  await test.runner.run({
    cwd: test.path,
    args: ['commit', '-q', '--no-verify', '--allow-empty', '-m', message],
    env: {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
    },
  });
}

/**
 * main: Alice adds a file and a binary one (UTC); "cc" adds a mailmap (+05:30); Carol renames the
 * file (-08:00); Bob's topic branch is merged after Alice's next change. A side branch by Dan is
 * not merged.
 */
async function history(test: TestRepo): Promise<void> {
  await commitAt(test, 'Add the app', '1704189600 +0000', ALICE, {
    'src/app.ts': 'a\nb\nc\n',
    'logo.png': 'PNG\0\0\u0001binary\0',
  });
  await commitAt(test, 'Add a mailmap', '1704276000 +0530', CAROL_OLD, {
    '.mailmap': 'Carol Chen <carol@x.dev> <cc@old.dev>\n',
  });
  await test.git('mv', 'src/app.ts', 'src/main.ts');
  await commitAt(test, 'Rename the app', '1704333600 -0800', CAROL, { 'src/main.ts': 'a\nb\nc\nd\n' });
  await test.checkoutNew('topic');
  await commitAt(test, 'Write notes', '1704445200 +0000', BOB, { 'docs/notes.md': 'one\ntwo\n' });
  await test.checkout('main');
  await commitAt(test, 'Grow the app', '1704456000 +0000', ALICE, { 'src/main.ts': 'a\nb\nc\nd\ne\n' });
  test.at('2024-01-06T12:00:00Z');
  await test.merge('topic', { noFF: true, message: 'Merge topic' });
  await test.checkoutNew('side', 'HEAD~1');
  await commitAt(test, 'Side work', '1704531600 +0000', DAN, { 'side.txt': 'side\n' });
  await test.checkout('main');
}

describe('statistics (real git)', () => {
  let test: TestRepo;
  let repo: Repository;
  let commands: GitCommandEnd[];

  beforeEach(async () => {
    commands = [];
    test = await TestRepo.create({
      runnerOptions: { listener: { onCommandEnd: (event) => commands.push(event) } },
    });
    repo = (await Repository.open(test.runner, test.path))!;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await test.dispose();
  });

  const labelled = (label: string) => commands.filter((command) => command.label === label);

  it('counts commits, merges and authors (mailmap applied), lines with renames and binary files', async () => {
    await history(test);
    const stats = new RepoStats(repo, { now: () => NOW });
    const before = await stats.get(query('head'));
    expect(before.scopeCommits).toBe(6);
    expect(before.lines).toMatchObject({ counted: 0, total: 5, pending: true });

    expect(await stats.countLines('head')).toEqual({ counted: 5, target: 5, computed: 5 });
    const result = await stats.get(query('head'));
    expect(result.head).toMatchObject({ branch: 'main', detached: false, unborn: false });
    expect(result.summary).toMatchObject({
      commits: 6,
      merges: 1,
      contributors: 3,
      // app.ts 3, .mailmap 1, the rename 1, notes 2, growth 1; the binary file and the merge add none.
      added: 8,
      removed: 0,
      files: 4,
      first: 1704189600,
      last: Date.parse('2024-01-06T12:00:00Z') / 1000,
    });
    expect(result.lines).toEqual({
      counted: 5,
      total: 5,
      limit: 20_000,
      all: false,
      scopeTotal: 5,
      pending: false,
    });
    expect(result.contributors.rows.map((row) => [row.name, row.commits, row.emails])).toEqual([
      ['Alice Archer', 3, ['alice@example.com']],
      ['Carol Chen', 2, ['carol@x.dev']],
      ['Bob Builder', 1, ['bob@example.com']],
    ]);
    // The renamed file keeps its history.
    expect(result.hotspots.rows[0]).toEqual({
      path: 'src/main.ts',
      commits: 3,
      added: 5,
      removed: 0,
      authors: 2,
    });
    expect(result.hotspots.rows.map((row) => row.path).sort()).toEqual(
      ['.mailmap', 'docs/notes.md', 'logo.png', 'src/main.ts'].sort(),
    );
    // Wednesday 15:30 in +05:30, and Wednesday 18:00 in -08:00 (Thursday in UTC).
    expect(result.punchCard[2 * 24 + 15]).toBe(1);
    expect(result.punchCard[2 * 24 + 18]).toBe(1);
    expect(result.punchCard[3 * 24 + 2]).toBe(0);

    const carol = await stats.get(query('head', { author: 'Carol Chen' }));
    expect(carol.summary).toMatchObject({ commits: 2, added: 2, files: 2 });
    expect(carol.author).toMatchObject({ name: 'Carol Chen', email: 'carol@x.dev', commits: 2, weekday: 2 });

    // Every branch: Dan's side branch too.
    await stats.countLines('all');
    const all = await stats.get(query('all'));
    expect(all.summary).toMatchObject({ commits: 7, contributors: 4, added: 9 });
    expect(all.contributors.rows.map((row) => row.name)).toContain('Dan Dubois');
  });

  it('reads only the new commits after a commit, and no lines it already counted', async () => {
    await history(test);
    const add = vi.spyOn(CommitStore.prototype, 'add');
    const stats = new RepoStats(repo, { now: () => NOW });
    await stats.get(query('head'));
    expect(add).toHaveBeenCalledTimes(6);
    expect((await stats.countLines('head')).computed).toBe(5);

    commands.length = 0;
    expect(await stats.countLines('head')).toEqual({ counted: 5, target: 5, computed: 0 });
    expect(labelled('Statistics: count changed lines')).toEqual([]);
    expect(labelled('Statistics: read commits')).toEqual([]);

    await test.commit('One more', { files: { 'more.txt': 'more\n' } });
    add.mockClear();
    commands.length = 0;
    expect(await stats.countLines('head')).toEqual({ counted: 6, target: 6, computed: 1 });
    // One commit read, and its lines alone counted.
    expect(add).toHaveBeenCalledTimes(1);
    expect(labelled('Statistics: read commits')).toHaveLength(1);
    expect(labelled('Statistics: count changed lines')).toHaveLength(1);
    expect((await stats.get(query('head'))).summary).toMatchObject({ commits: 7, added: 9 });

    // Reset back: the commit is gone from the scope (its lines are not counted any more).
    await test.git('reset', '-q', '--hard', 'HEAD~1');
    add.mockClear();
    const after = await stats.get(query('head'));
    expect(after.summary).toMatchObject({ commits: 6, added: 8 });
    expect(add).not.toHaveBeenCalled();
    expect(labelled('Statistics: commits gone')).toHaveLength(1);
  });

  it('reads the refs again only when the repository changed, or a refresh is asked for', async () => {
    await history(test);
    const stats = new RepoStats(repo, { now: () => NOW, tipsMaxAge: Infinity });
    await stats.get(query('head'));
    commands.length = 0;
    // Another author, order or range: counted again from memory, no git at all.
    await stats.get(query('head', { author: 'Carol Chen', sort: 'lines', range: '30d' }));
    expect(commands).toEqual([]);

    await test.commit('One more', { files: { 'more.txt': 'more\n' } });
    commands.length = 0;
    expect((await stats.get(query('head'))).scopeCommits).toBe(6);
    expect(commands).toEqual([]);
    stats.changed();
    expect((await stats.get(query('head'))).scopeCommits).toBe(7);
    await test.commit('And another', { files: { 'more.txt': 'more\nand more\n' } });
    expect((await stats.get(query('head', { refresh: true }))).scopeCommits).toBe(8);
  });

  it('counts lines for the newest commits only, newest first', async () => {
    await history(test);
    const progress: unknown[] = [];
    const stats = new RepoStats(repo, { now: () => NOW, lineLimit: 2, onProgress: (p) => progress.push(p) });
    expect(await stats.countLines('head')).toEqual({ counted: 2, target: 2, computed: 2 });
    const result = await stats.get(query('head'));
    // The newest two (merges aside): Alice's growth and Bob's notes.
    expect(result.lines).toEqual({
      counted: 2,
      total: 5,
      limit: 2,
      all: false,
      scopeTotal: 5,
      pending: false,
    });
    expect(result.summary).toMatchObject({ added: 3, files: 2 });
    expect(progress).toContainEqual({ scope: 'head', phase: 'lines', done: 2, total: 2 });
    // Carol's commits are older than the two: her lines are not known.
    expect(result.contributors.rows.find((row) => row.name === 'Carol Chen')).toMatchObject({
      countable: 2,
      counted: 0,
      counting: 0,
    });
  });

  it('counts every commit’s lines when asked, past the limit, and goes back to the newest', async () => {
    await history(test);
    const progress: unknown[] = [];
    const stats = new RepoStats(repo, { now: () => NOW, lineLimit: 2, onProgress: (p) => progress.push(p) });
    expect(await stats.countLines('head')).toEqual({ counted: 2, target: 2, computed: 2 });
    const latest = await stats.get(query('head'));
    expect(latest.lines).toMatchObject({ counted: 2, total: 5, all: false, scopeTotal: 5 });

    // Every commit: only the three not counted yet are read.
    commands.length = 0;
    expect(await stats.countLines('head', undefined, false, 'all')).toEqual({
      counted: 5,
      target: 5,
      computed: 3,
    });
    expect(labelled('Statistics: count changed lines')).toHaveLength(1);
    expect(progress.at(-1)).toEqual({ scope: 'head', phase: 'lines', done: 5, total: 5 });
    const all = await stats.get(query('head', { lines: 'all' }));
    expect(all.lines).toEqual({ counted: 5, total: 5, limit: 2, all: true, scopeTotal: 5, pending: false });
    expect(all.summary).toMatchObject({ added: 8, files: 4 });
    expect(all.contributors.rows.find((row) => row.name === 'Carol Chen')).toMatchObject({
      countable: 2,
      counted: 2,
      added: 2,
    });

    // Back to the newest two: their numbers again, nothing read.
    commands.length = 0;
    expect(await stats.countLines('head')).toEqual({ counted: 2, target: 2, computed: 0 });
    expect((await stats.get(query('head'))).lines).toMatchObject({ counted: 2, all: false });
    expect(labelled('Statistics: count changed lines')).toEqual([]);
  });

  it('stops counting every commit when the view goes back to the newest ones', async () => {
    await history(test);
    const stats = new RepoStats(repo, { now: () => NOW, lineLimit: 2 });
    const controller = new AbortController();
    const all = stats.countLines('head', controller.signal, false, 'all');
    // The newest two are counted on their own: not behind the job that counts everything.
    const latest = stats.countLines('head');
    controller.abort();
    await expect(all).rejects.toThrow(/Cancelled/);
    expect(await latest).toMatchObject({ counted: 2, target: 2 });
    expect(stats.busy).toBe(false);
  });

  it('stops counting when nobody waits, and goes on where it stopped', async () => {
    await history(test);
    const stats = new RepoStats(repo, { now: () => NOW });
    const controller = new AbortController();
    const counting = stats.countLines('head', controller.signal);
    controller.abort();
    await expect(counting).rejects.toThrow(/Cancelled/);
    expect(await stats.countLines('head')).toMatchObject({ counted: 5, target: 5 });
  });

  it('has nothing to count before the first commit, and follows a detached HEAD', async () => {
    const stats = new RepoStats(repo, { now: () => NOW });
    const empty = await stats.get(query('head'));
    expect(empty.head.unborn).toBe(true);
    expect(empty.scopeCommits).toBe(0);
    expect(empty.summary.commits).toBe(0);
    expect((await stats.get(query('all'))).scopeCommits).toBe(0);
    expect(await stats.countLines('head')).toEqual({ counted: 0, target: 0, computed: 0 });
    expect(await stats.languages()).toEqual({ languages: [], files: 0, bytes: 0 });

    await history(test);
    await test.git('checkout', '-q', '--detach', 'HEAD~1');
    const detached = await stats.get(query('head'));
    expect(detached.head.detached).toBe(true);
    expect(detached.scopeCommits).toBe(4);
  });

  it('says what HEAD’s files are written in', async () => {
    await history(test);
    const languages = await new RepoStats(repo).languages();
    expect(languages.files).toBe(4);
    expect(languages.languages.map((language) => [language.language, language.files])).toEqual([
      ['TypeScript', 1],
      ['Markdown', 1],
      ['Other', 2],
    ]);
  });
});

/** A webview as the backend sees it: calls methods and collects events. */
class View implements RpcTransport {
  readonly events: { event: string; payload: unknown }[] = [];
  private handler: ((message: RpcMessage) => void) | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, (message: RpcMessage) => void>();

  send(message: RpcMessage): void {
    if (message.kind === 'evt') this.events.push({ event: message.event, payload: message.payload });
    else if (message.kind === 'res') this.pending.get(message.id)?.(message);
  }

  onMessage(handler: (message: RpcMessage) => void): () => void {
    this.handler = handler;
    return () => (this.handler = undefined);
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.kind !== 'res') return;
        if (message.ok) resolve(message.result as T);
        else reject(new Error(message.error.message));
      });
      this.handler?.({ kind: 'req', id, method, params });
    });
  }
}

describe('statistics over RPC (real git)', () => {
  let test: TestRepo | undefined;
  let backend: Backend | undefined;

  afterEach(async () => {
    backend?.dispose();
    await test?.dispose();
  });

  it('answers the view, reports progress and refuses what it should not do', async () => {
    test = await TestRepo.create();
    await history(test);
    const registry = new RepositoryRegistry();
    backend = new Backend({ platform: new HarnessPlatform(), registry, console: new ConsoleLog() });
    backend.setGit(test.runner);
    const repo = (await Repository.open(test.runner, test.path))!;
    registry.add(repo);
    const view = new View();
    backend.connect(view);
    const params = { repoId: repo.id, ...query('head') };

    expect(await view.call('stats.countLines', { repoId: repo.id, scope: 'head' })).toMatchObject({
      counted: 5,
    });
    const result = await view.call<StatsResult>('stats.get', params);
    expect(result.summary).toMatchObject({ commits: 6, added: 8 });
    const progress = view.events
      .filter((e) => e.event === 'stats.progress')
      .map((e) => e.payload as StatsProgress);
    expect(progress.at(-1)).toEqual({ repoId: repo.id, scope: 'head', phase: 'lines', done: 5, total: 5 });
    expect((await view.call<{ files: number }>('stats.languages', { repoId: repo.id })).files).toBe(4);

    await expect(view.call('stats.get', { ...params, scope: 'everything' })).rejects.toThrow(/scope/);
    await expect(view.call('stats.get', { ...params, range: 'forever' })).rejects.toThrow(/range/);
    await expect(view.call('stats.get', { ...params, author: 'x'.repeat(1000) })).rejects.toThrow(/author/);
    await expect(view.call('stats.get', { ...params, lines: 'most' })).rejects.toThrow(/line counting/);
    expect(
      await view.call('stats.countLines', { repoId: repo.id, scope: 'head', lines: 'all' }),
    ).toMatchObject({
      counted: 5,
      target: 5,
    });
    expect((await view.call<StatsResult>('stats.get', { ...params, lines: 'all' })).lines).toMatchObject({
      all: true,
      counted: 5,
    });
    await expect(
      view.call('stats.countLines', { repoId: repo.id, scope: 'head', lines: '--all' }),
    ).rejects.toThrow(/line counting/);
    await expect(view.call('stats.get', { ...params, repoId: '/not/open' })).rejects.toThrow(
      /Unknown repository/,
    );
    await expect(view.call('stats.countLines', { repoId: repo.id, scope: '--all' })).rejects.toThrow(/scope/);
  });
});
