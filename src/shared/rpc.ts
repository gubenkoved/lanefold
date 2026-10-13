/**
 * A small, typed, transport-agnostic RPC layer used between the extension host and the
 * webview (over `postMessage`) and between the dev harness and the webview (over WebSocket).
 *
 * APIs are described as interfaces of one-argument functions:
 *
 *   interface HostApi { 'repo.list'(): RepoSummary[]; 'log.page'(p: PageParams): Page }
 *
 * and events as interfaces of payload types:
 *
 *   interface HostEvents { 'console.entry': ConsoleEntry }
 */

export type RpcMessage =
  | { readonly kind: 'req'; readonly id: number; readonly method: string; readonly params: unknown }
  | { readonly kind: 'res'; readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly kind: 'res'; readonly id: number; readonly ok: false; readonly error: RpcErrorPayload }
  | { readonly kind: 'cancel'; readonly id: number }
  | { readonly kind: 'evt'; readonly event: string; readonly payload: unknown };

export interface RpcErrorPayload {
  readonly message: string;
  /** Machine-readable error kind (e.g. a GitErrorKind). */
  readonly code?: string;
  readonly data?: unknown;
}

export interface RpcTransport {
  send(message: RpcMessage): void;
  /** Subscribes to incoming messages; returns an unsubscribe function. */
  onMessage(handler: (message: RpcMessage) => void): () => void;
  /** Whether the other side is on screen now (assumed when absent). */
  readonly visible?: boolean;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface CallOptions {
  readonly signal?: AbortSignal;
}

export interface HandlerContext {
  /** Aborted when the caller cancels or the endpoint is disposed. */
  readonly signal: AbortSignal;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => unknown;
export type ParamsOf<F> = F extends (params: infer P) => unknown ? P : undefined;
export type ResultOf<F> = F extends AnyFn ? Awaited<ReturnType<F>> : never;
export type CallArgs<F> = F extends () => unknown
  ? [params?: undefined, options?: CallOptions]
  : [params: ParamsOf<F>, options?: CallOptions];

export type Handler<F> = (params: ParamsOf<F>, context: HandlerContext) => ResultOf<F> | Promise<ResultOf<F>>;
export type Handlers<Api> = { [K in keyof Api]: Handler<Api[K]> };

type Pending = { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void };

/** Serializes thrown values into a payload the other side can rethrow as {@link RpcError}. */
export function toErrorPayload(error: unknown): RpcErrorPayload {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: unknown; kind?: unknown; data?: unknown; files?: unknown };
    const code =
      typeof withCode.kind === 'string'
        ? withCode.kind
        : typeof withCode.code === 'string'
          ? withCode.code
          : undefined;
    const data = withCode.data ?? (Array.isArray(withCode.files) ? { files: withCode.files } : undefined);
    return { message: error.message, code, data };
  }
  return { message: String(error) };
}

export class RpcEndpoint<
  LocalApi extends object,
  RemoteApi extends object,
  LocalEvents extends object = Record<never, never>,
  RemoteEvents extends object = Record<never, never>,
> {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Handler<AnyFn>>();
  private readonly inflight = new Map<number, AbortController>();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly transport: RpcTransport) {
    this.unsubscribe = transport.onMessage((message) => this.receive(message));
  }

  /** Calls a method implemented by the other side. */
  call<K extends keyof RemoteApi & string>(
    method: K,
    ...args: CallArgs<RemoteApi[K]>
  ): Promise<ResultOf<RemoteApi[K]>> {
    const [params, options] = args as [unknown, CallOptions | undefined];
    if (this.disposed) return Promise.reject(new RpcError('RPC endpoint disposed', 'disposed'));
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(new RpcError('Cancelled', 'cancelled'));

    const id = this.nextId++;
    return new Promise<ResultOf<RemoteApi[K]>>((resolve, reject) => {
      const onAbort = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.cleanup();
        this.transport.send({ kind: 'cancel', id });
        reject(new RpcError('Cancelled', 'cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      });
      this.transport.send({ kind: 'req', id, method, params });
    });
  }

  /** Registers the implementation of one local method. */
  handle<K extends keyof LocalApi & string>(method: K, handler: Handler<LocalApi[K]>): void {
    this.handlers.set(method, handler as Handler<AnyFn>);
  }

  /** Registers implementations for many local methods at once. */
  implement(handlers: Partial<Handlers<LocalApi>>): void {
    for (const [method, handler] of Object.entries(handlers)) {
      if (handler) this.handlers.set(method, handler as Handler<AnyFn>);
    }
  }

  /** Sends an event to the other side. */
  emit<K extends keyof LocalEvents & string>(event: K, payload: LocalEvents[K]): void {
    if (!this.disposed) this.transport.send({ kind: 'evt', event, payload });
  }

  /** Listens for events from the other side; returns an unsubscribe function. */
  on<K extends keyof RemoteEvents & string>(
    event: K,
    listener: (payload: RemoteEvents[K]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const wrapped = listener as (payload: unknown) => void;
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const [, entry] of this.pending) {
      entry.cleanup();
      entry.reject(new RpcError('RPC endpoint disposed', 'disposed'));
    }
    this.pending.clear();
    for (const [, controller] of this.inflight) controller.abort();
    this.inflight.clear();
    this.listeners.clear();
  }

  private receive(message: RpcMessage): void {
    switch (message.kind) {
      case 'req':
        void this.dispatch(message.id, message.method, message.params);
        return;
      case 'res': {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        entry.cleanup();
        if (message.ok) entry.resolve(message.result);
        else entry.reject(new RpcError(message.error.message, message.error.code, message.error.data));
        return;
      }
      case 'cancel':
        this.inflight.get(message.id)?.abort();
        return;
      case 'evt': {
        const set = this.listeners.get(message.event);
        if (!set) return;
        for (const listener of [...set]) {
          try {
            listener(message.payload);
          } catch (error) {
            console.error(`[lanefold] listener for ${message.event} failed`, error);
          }
        }
        return;
      }
    }
  }

  private async dispatch(id: number, method: string, params: unknown): Promise<void> {
    // Let the owner finish registering handlers if a transport delivers during construction.
    await Promise.resolve();
    const handler = this.handlers.get(method);
    if (!handler) {
      this.transport.send({
        kind: 'res',
        id,
        ok: false,
        error: { message: `Unknown method: ${method}`, code: 'unknownMethod' },
      });
      return;
    }
    const controller = new AbortController();
    this.inflight.set(id, controller);
    try {
      const result = await handler(params as never, { signal: controller.signal });
      if (!controller.signal.aborted && !this.disposed)
        this.transport.send({ kind: 'res', id, ok: true, result });
    } catch (error) {
      if (!controller.signal.aborted && !this.disposed) {
        this.transport.send({ kind: 'res', id, ok: false, error: toErrorPayload(error) });
      }
    } finally {
      this.inflight.delete(id);
    }
  }
}

/** Two linked in-memory transports (tests, and same-process hosting). */
export function createTransportPair(): [RpcTransport, RpcTransport] {
  const handlersA = new Set<(message: RpcMessage) => void>();
  const handlersB = new Set<(message: RpcMessage) => void>();
  const deliver = (targets: Set<(message: RpcMessage) => void>, message: RpcMessage) =>
    queueMicrotask(() => {
      for (const handler of [...targets]) handler(message);
    });
  const a: RpcTransport = {
    send: (message) => deliver(handlersB, message),
    onMessage: (handler) => {
      handlersA.add(handler);
      return () => handlersA.delete(handler);
    },
  };
  const b: RpcTransport = {
    send: (message) => deliver(handlersA, message),
    onMessage: (handler) => {
      handlersB.add(handler);
      return () => handlersB.delete(handler);
    },
  };
  return [a, b];
}
