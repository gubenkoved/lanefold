import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Backend } from '../../src/core/backend/backend';
import { HarnessPlatform } from '../../dev/harness/platform';
import { ConsoleLog } from '../../src/core/console/consoleLog';
import { RepositoryRegistry } from '../../src/core/repo/registry';
import { Repository } from '../../src/core/repo/repository';
import { GraphTopology, type TopologyChunk } from '../../src/shared/graph/topology';
import type { ViewConfig } from '../../src/shared/models';
import type { LogOpenResult } from '../../src/shared/protocol';
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

  /** The rows of a log, once git finished streaming it. */
  async rows(logId: number, oidBytes: number): Promise<{ sha: string; parents: string[] }[]> {
    const ended = () =>
      this.events.some((e) => e.event === 'log.end' && (e.payload as { logId: number }).logId === logId);
    for (let i = 0; i < 200 && !ended(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const topology = new GraphTopology(oidBytes);
    for (const { event, payload } of this.events)
      if (event === 'log.chunk' && (payload as TopologyChunk).logId === logId)
        topology.appendChunk(payload as TopologyChunk);
    return Array.from({ length: topology.rowCount }, (_, row) => ({
      sha: topology.oidHex(row),
      parents: Array.from({ length: topology.parentCount(row) }, (_, index) =>
        topology.oidHexOfId(topology.parentId(row, index)),
      ),
    }));
  }
}

const ALL: ViewConfig = { scope: { type: 'all' } } as ViewConfig;

describe('log views (real git)', () => {
  let test: TestRepo | undefined;
  let backend: Backend | undefined;

  afterEach(async () => {
    backend?.dispose();
    await test?.dispose();
  });

  async function open(): Promise<View> {
    test ??= await TestRepo.create();
    const registry = new RepositoryRegistry();
    backend = new Backend({ platform: new HarnessPlatform(), registry, console: new ConsoleLog() });
    backend.setGit(test.runner);
    registry.add((await Repository.open(test.runner, test.path))!);
    const view = new View();
    backend.connect(view);
    return view;
  }

  it('shows the changes of a repository without commits as the one row to commit them from', async () => {
    test = await TestRepo.create();
    await writeFile(join(test.path, 'README.md'), '# New\n');
    const view = await open();
    const repoId = (await view.call<{ repos: { id: string }[] }>('app.init', {})).repos[0]!.id;
    const result = await view.call<LogOpenResult>('log.open', { repoId, view: ALL });
    expect(result.empty).toBe(false);
    const rows = await view.rows(result.logId, result.oidBytes);
    expect(rows).toEqual([{ sha: '0'.repeat(40), parents: [] }]);
  });

  it('gives the changes of a merge in progress both parents', async () => {
    test = await TestRepo.create();
    await test.commits('one');
    await test.checkoutNew('feature');
    await test.commit('feature side', { files: { 'shared.txt': 'feature\n' } });
    await test.checkout('main');
    await test.commit('main side', { files: { 'shared.txt': 'main\n' } });
    await test.git('merge', 'feature').catch(() => undefined);
    const view = await open();
    const repoId = (await view.call<{ repos: { id: string }[] }>('app.init', {})).repos[0]!.id;
    const result = await view.call<LogOpenResult>('log.open', { repoId, view: ALL });
    const [changes] = await view.rows(result.logId, result.oidBytes);
    expect(changes).toEqual({
      sha: '0'.repeat(40),
      parents: [await test.rev('main'), await test.rev('feature')],
    });
  });
});
