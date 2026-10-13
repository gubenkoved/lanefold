import { describe, expect, it } from 'vitest';
import { decodeMessage, encodeMessage } from '../../src/shared/codec';
import { createTransportPair, RpcEndpoint, RpcError, type RpcMessage } from '../../src/shared/rpc';

interface ServerApi {
  add(params: { a: number; b: number }): number;
  ping(): string;
  fail(): never;
  slow(params: { ms: number }): string;
  buffers(): { lanes: Int32Array; raw: ArrayBuffer };
}

interface ServerEvents {
  tick: { n: number };
}

function setup() {
  const [a, b] = createTransportPair();
  const server = new RpcEndpoint<ServerApi, Record<never, never>, ServerEvents>(a);
  const client = new RpcEndpoint<Record<never, never>, ServerApi, Record<never, never>, ServerEvents>(b);
  return { server, client };
}

describe('RpcEndpoint', () => {
  it('routes typed requests and responses', async () => {
    const { server, client } = setup();
    server.implement({
      add: ({ a, b }) => a + b,
      ping: () => 'pong',
    });
    await expect(client.call('add', { a: 2, b: 3 })).resolves.toBe(5);
    await expect(client.call('ping')).resolves.toBe('pong');
  });

  it('propagates errors with their code and data', async () => {
    const { server, client } = setup();
    server.handle('fail', () => {
      const error = new Error('dirty tree') as Error & { kind: string; files: string[] };
      error.kind = 'dirtyWorkTree';
      error.files = ['a.txt'];
      throw error;
    });
    const error = (await client.call('fail').catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error.message).toBe('dirty tree');
    expect(error.code).toBe('dirtyWorkTree');
    expect(error.data).toEqual({ files: ['a.txt'] });
  });

  it('rejects unknown methods', async () => {
    const { client } = setup();
    await expect(client.call('ping')).rejects.toMatchObject({ code: 'unknownMethod' });
  });

  it('cancels in-flight calls on both sides', async () => {
    const { server, client } = setup();
    let handlerSawAbort = false;
    server.handle('slow', ({ ms }, { signal }) => {
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('done'), ms);
        signal.addEventListener('abort', () => {
          handlerSawAbort = true;
          clearTimeout(timer);
          resolve('aborted');
        });
      });
    });
    const controller = new AbortController();
    const pending = client.call('slow', { ms: 5_000 }, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((r) => setTimeout(r, 10));
    expect(handlerSawAbort).toBe(true);
  });

  it('delivers events to listeners until unsubscribed', async () => {
    const { server, client } = setup();
    const seen: number[] = [];
    const off = client.on('tick', ({ n }) => seen.push(n));
    server.emit('tick', { n: 1 });
    server.emit('tick', { n: 2 });
    await new Promise((r) => setTimeout(r, 0));
    off();
    server.emit('tick', { n: 3 });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([1, 2]);
  });

  it('rejects pending calls on dispose', async () => {
    const { server, client } = setup();
    server.handle('slow', () => new Promise<string>(() => undefined));
    const pending = client.call('slow', { ms: 1 });
    client.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'disposed' });
  });
});

describe('codec', () => {
  it('round-trips typed arrays and array buffers', () => {
    const lanes = new Int32Array([1, -2, 300000, 4]);
    const raw = new Uint8Array([9, 8, 7]).buffer;
    const message: RpcMessage = {
      kind: 'res',
      id: 7,
      ok: true,
      result: { lanes, raw, nested: [new Float64Array([1.5])] },
    };
    const decoded = decodeMessage(encodeMessage(message));
    expect(decoded.kind).toBe('res');
    const result = (decoded as { result: { lanes: Int32Array; raw: ArrayBuffer; nested: Float64Array[] } })
      .result;
    expect(result.lanes).toBeInstanceOf(Int32Array);
    expect([...result.lanes]).toEqual([1, -2, 300000, 4]);
    expect([...new Uint8Array(result.raw)]).toEqual([9, 8, 7]);
    expect(result.nested[0]).toBeInstanceOf(Float64Array);
    expect([...result.nested[0]!]).toEqual([1.5]);
  });

  it('handles typed array views at an offset', () => {
    const backing = new Int32Array([10, 20, 30, 40]);
    const view = backing.subarray(1, 3);
    const decoded = decodeMessage(encodeMessage({ kind: 'evt', event: 'x', payload: view }));
    expect([...(decoded as { payload: Int32Array }).payload]).toEqual([20, 30]);
  });
});
