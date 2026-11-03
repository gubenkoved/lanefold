import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRpc } from '../../src/webview/bridge/host';
import type { LogModel } from '../../src/webview/graph/logModel';
import { LogLoader } from '../../src/webview/views/log/useLogModel';

/** A log model whose loading the test plays out. */
class FakeModel {
  phase: 'opening' | 'streaming' | 'ready' = 'opening';
  readonly topology = { rowCount: 0 };
  complete: boolean | undefined;
  disposed = false;
  private missing: string[] = [];
  private readonly listeners = new Set<() => void>();

  open(options: { complete?: boolean }): Promise<void> {
    this.complete = options.complete;
    return Promise.resolve();
  }

  /** Streams `rows` rows; `missing` (refs a fast load left out) ends the log. */
  stream(rows: number, missing?: string[]): void {
    this.topology.rowCount = rows;
    this.phase = missing ? 'ready' : 'streaming';
    this.missing = missing ?? [];
    for (const listener of [...this.listeners]) listener();
  }

  missingRefs(): string[] {
    return this.phase === 'ready' ? this.missing : [];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

function setUp() {
  const models: FakeModel[] = [];
  const shown: FakeModel[] = [];
  const loader = new LogLoader(
    {} as HostRpc,
    'aurora',
    { scope: { type: 'all' } },
    ({ model }) => shown.push(model as unknown as FakeModel),
    () => 0,
    () => {
      const model = new FakeModel();
      models.push(model);
      return model as unknown as LogModel;
    },
  );
  loader.start(undefined);
  models[0]!.stream(20, []);
  return { loader, models, shown };
}

describe('a reload of a log view', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('that missed old refs shows the complete history at once, so no branch blinks', () => {
    const { loader, models, shown } = setUp();
    // After a commit far newer than every other ref, the fast load starts from it alone.
    loader.refresh();
    models[1]!.stream(14, ['refs/remotes/origin/main']);
    expect(models[1]!.disposed).toBe(true);
    expect(models[2]!.complete).toBe(true);
    expect(shown).toEqual([models[0]]);
    models[2]!.stream(20, []);
    expect(shown).toEqual([models[0], models[2]]);
  });

  it('shows a long history as it streams, then the refs it missed', () => {
    const { loader, models, shown } = setUp();
    loader.refresh();
    models[1]!.stream(400);
    expect(shown).toEqual([models[0], models[1]]);
    models[1]!.stream(1000, ['refs/tags/v0.1']);
    expect(models[2]!.complete).toBe(true);
    models[2]!.stream(1010, []);
    expect(shown).toEqual([models[0], models[1], models[2]]);
  });
});
