import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessPlatform } from '../../dev/harness/platform';
import { Backend } from '../../src/core/backend/backend';
import { ConsoleLog } from '../../src/core/console/consoleLog';
import { RepositoryRegistry } from '../../src/core/repo/registry';
import { Repository } from '../../src/core/repo/repository';
import { GraphTopology, type TopologyChunk } from '../../src/shared/graph/topology';
import type { ViewConfig } from '../../src/shared/models';
import type { LogEnd, ReposLogOpenResult } from '../../src/shared/protocol';
import type { RpcMessage, RpcTransport } from '../../src/shared/rpc';
import { TestRepo } from '../fixtures/repoBuilder';

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

  /** How the log ended, once git finished streaming it. */
  async end(logId: number): Promise<LogEnd> {
    const find = () =>
      this.events.find((e) => e.event === 'log.end' && (e.payload as LogEnd).logId === logId)?.payload as
        LogEnd | undefined;
    for (let i = 0; i < 500 && !find(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    return find()!;
  }

  /** The rows of a log (with the index of their repository), once it ended. */
  async rows(logId: number, oidBytes: number): Promise<{ sha: string; parents: string[]; repo: number }[]> {
    await this.end(logId);
    const topology = new GraphTopology(oidBytes);
    for (const { event, payload } of this.events)
      if (event === 'log.chunk' && (payload as TopologyChunk).logId === logId)
        topology.appendChunk(payload as TopologyChunk);
    return Array.from({ length: topology.rowCount }, (_, row) => ({
      sha: topology.oidHex(row),
      parents: Array.from({ length: topology.parentCount(row) }, (_, index) =>
        topology.oidHexOfId(topology.parentId(row, index)),
      ),
      repo: topology.rowRepo(row),
    }));
  }
}

const ALL: ViewConfig = { scope: { type: 'all' } };

describe('the log of several repositories (real git)', () => {
  const repos: TestRepo[] = [];
  let backend: Backend | undefined;

  afterEach(async () => {
    backend?.dispose();
    backend = undefined;
    await Promise.all(repos.splice(0).map((repo) => repo.dispose()));
  });

  async function repo(): Promise<TestRepo> {
    const created = await TestRepo.create();
    repos.push(created);
    return created;
  }

  /** A backend with these folders open (in this order); returns their repository ids. */
  async function open(...paths: string[]): Promise<{ view: View; ids: string[] }> {
    const runner = repos[0]!.runner;
    const registry = new RepositoryRegistry();
    backend = new Backend({ platform: new HarnessPlatform(), registry, console: new ConsoleLog() });
    backend.setGit(runner);
    const ids: string[] = [];
    for (const path of paths) {
      const opened = (await Repository.open(runner, path))!;
      registry.add(opened);
      ids.push(opened.id);
    }
    const view = new View();
    backend.connect(view);
    return { view, ids };
  }

  it('merges the histories newest first, each row with its repository and its refs', async () => {
    const a = await repo();
    const b = await repo();
    const empty = await repo();
    const a1 = await a.at('2024-01-01').commit('a1');
    await a.tag('v1');
    const a2 = await a.at('2024-01-03').commit('a2');
    const b1 = await b.at('2024-01-02').commit('b1');
    await b.branch('topic');
    const b2 = await b.at('2024-01-04').commit('b2');
    const { view, ids } = await open(a.path, b.path, empty.path);

    const result = await view.call<ReposLogOpenResult>('log.openRepos', { repoIds: ids, view: ALL });
    expect(result.empty).toBe(false);
    expect(result.sources.map((source) => source.repoId)).toEqual(ids);
    expect(result.sources[0]!.refs.refs.map((ref) => ref.short).sort()).toEqual(['main', 'v1']);
    expect(result.sources[1]!.refs.refs.map((ref) => ref.short).sort()).toEqual(['main', 'topic']);
    expect(result.sources[2]!.refs.head.unborn).toBe(true);

    const rows = await view.rows(result.logId, result.oidBytes);
    expect(rows).toEqual([
      { sha: b2, parents: [b1], repo: 1 },
      { sha: a2, parents: [a1], repo: 0 },
      { sha: b1, parents: [], repo: 1 },
      { sha: a1, parents: [], repo: 0 },
    ]);
    expect((await view.end(result.logId)).sourceErrors).toBeUndefined();

    // The current branch only, in the order asked for.
    await b.checkout('topic');
    const heads = await view.call<ReposLogOpenResult>('log.openRepos', {
      repoIds: [ids[1], ids[0]],
      view: { scope: { type: 'head' } },
    });
    expect((await view.rows(heads.logId, heads.oidBytes)).map((row) => [row.sha, row.repo])).toEqual([
      [a2, 1],
      [b1, 0],
      [a1, 1],
    ]);
  });

  it('shows the commits of clones once, as the first repository’s', async () => {
    const origin = await repo();
    const clone = await repo();
    const s1 = await origin.at('2024-01-01').commit('s1');
    const s2 = await origin.at('2024-01-02').commit('s2');
    await clone.git('fetch', '-q', origin.path, 'main');
    await clone.git('reset', '-q', '--hard', 'FETCH_HEAD');
    const mine = await clone.at('2024-01-05').commit('mine');
    const { view, ids } = await open(origin.path, clone.path);

    const first = await view.call<ReposLogOpenResult>('log.openRepos', { repoIds: ids, view: ALL });
    expect(await view.rows(first.logId, first.oidBytes)).toEqual([
      { sha: mine, parents: [s2], repo: 1 },
      { sha: s2, parents: [s1], repo: 0 },
      { sha: s1, parents: [], repo: 0 },
    ]);
    const reversed = await view.call<ReposLogOpenResult>('log.openRepos', {
      repoIds: [...ids].reverse(),
      view: ALL,
    });
    expect((await view.rows(reversed.logId, reversed.oidBytes)).map((row) => row.repo)).toEqual([0, 0, 0]);
  });

  it('reads the linked worktrees of a repository once, from every one of their HEADs', async () => {
    const main = await repo();
    const m1 = await main.at('2024-01-01').commit('m1');
    const folder = `${main.path}-linked`;
    await main.git('worktree', 'add', '-q', '--detach', folder);
    // A commit only the linked worktree's (detached) HEAD reaches.
    const date = `${Date.parse('2024-01-06T10:00:00Z') / 1000} +0000`;
    await main.runner.run({
      cwd: folder,
      args: ['commit', '-q', '--allow-empty', '-m', 'detached work'],
      env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    const detached = (await main.runner.run({ cwd: folder, args: ['rev-parse', 'HEAD'] })).stdout.trim();
    const { view, ids } = await open(main.path, folder);

    const result = await view.call<ReposLogOpenResult>('log.openRepos', { repoIds: ids, view: ALL });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ repoId: ids[0], worktrees: [ids[1]] });
    expect(result.sources[0]!.worktreeHeads[0]).toMatchObject({ sha: detached, detached: true });
    expect(await view.rows(result.logId, result.oidBytes)).toEqual([
      { sha: detached, parents: [m1], repo: 0 },
      { sha: m1, parents: [], repo: 0 },
    ]);
    await rm(folder, { recursive: true, force: true });
  });

  it('reports a repository whose history cannot be read, and shows the others', async () => {
    const good = await repo();
    const broken = await repo();
    const g1 = await good.at('2024-01-01').commit('g1');
    const first = await broken.at('2024-01-02').commit('first');
    await broken.at('2024-01-03').commit('second');
    // Lose the older commit's object: walking the history fails there.
    await rm(join(broken.path, '.git', 'objects', first.slice(0, 2), first.slice(2)));
    const { view, ids } = await open(good.path, broken.path);

    const result = await view.call<ReposLogOpenResult>('log.openRepos', { repoIds: ids, view: ALL });
    const rows = await view.rows(result.logId, result.oidBytes);
    expect(rows).toContainEqual({ sha: g1, parents: [], repo: 0 });
    const end = await view.end(result.logId);
    expect(end.error).toBeUndefined();
    expect(Object.keys(end.sourceErrors ?? {})).toEqual(['1']);
  });

  it('refuses views it cannot merge, and leaves out repositories that are not open', async () => {
    const a = await repo();
    await a.commit('a1');
    const { view, ids } = await open(a.path);
    await expect(
      view.call('log.openRepos', { repoIds: ids, view: { scope: { type: 'refs', refs: ['main'] } } }),
    ).rejects.toThrow(/all, local or current branches/);
    const result = await view.call<ReposLogOpenResult>('log.openRepos', {
      repoIds: [...ids, '/not/open'],
      view: ALL,
    });
    expect(result.sources.map((source) => source.repoId)).toEqual(ids);
    expect(await view.rows(result.logId, result.oidBytes)).toHaveLength(1);
  });
});
