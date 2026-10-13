import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { TopologyChunk } from '../../shared/graph/topology';
import type { GitBinary } from '../git/binary';
import { GitError } from '../git/errors';
import {
  type GitRunner,
  type GitCommandEnd,
  type GitCommandListener,
  type GitCommandStart,
} from '../git/runner';
import type { Repository } from '../repo/repository';
import { MergedTopologyParser } from './mergedParser';
import { mergedEndInfo, streamMerged, type MergedSourceSpec } from './mergedStream';
import { TopologyParser, type ParsedChunk } from './topologyParser';

export interface LogEndInfo {
  readonly rowCount: number;
  readonly durationMs: number;
  readonly error?: string;
  readonly cancelled?: boolean;
  /** Merged logs: streams that ended with an error, by index. */
  readonly sourceErrors?: Readonly<Record<number, string>>;
}

/** One repository of a merged log: the rev-list to run in it. */
export interface MergedSource {
  readonly repo: Repository;
  readonly args: readonly string[];
  readonly stdin?: string;
}

export interface LogCallbacks {
  onChunk(chunk: TopologyChunk): void;
  onEnd(info: LogEndInfo): void;
}

export interface LogStream {
  readonly logId: number;
  cancel(): void;
}

/** Messages between the log engine and its worker thread. */
export type WorkerRequest =
  | {
      readonly type: 'open';
      readonly logId: number;
      readonly git: { readonly path: string; readonly versionRaw: string };
      readonly cwd: string;
      readonly args: readonly string[];
      readonly oidBytes: number;
      readonly prefix: string;
      readonly stdin?: string;
    }
  | {
      readonly type: 'openMerged';
      readonly logId: number;
      readonly git: { readonly path: string; readonly versionRaw: string };
      readonly sources: readonly MergedSourceSpec[];
      readonly oidBytes: number;
    }
  | { readonly type: 'cancel'; readonly logId: number };

export type WorkerResponse =
  | { readonly type: 'chunk'; readonly logId: number; readonly chunk: ParsedChunk }
  | { readonly type: 'end'; readonly logId: number; readonly info: LogEndInfo }
  | { readonly type: 'command-start'; readonly event: GitCommandStart }
  | { readonly type: 'command-end'; readonly event: GitCommandEnd };

let nextLogId = 1;

/**
 * Streams commit topology for log views. With a worker script, git output is parsed off the
 * extension host's main thread (shared with every other extension); without one (tests,
 * fallback) parsing runs in-process. Both paths produce identical chunks.
 */
export class LogEngine {
  private worker: Worker | undefined;
  private readonly streams = new Map<number, LogCallbacks>();

  constructor(
    private readonly options: {
      readonly workerPath?: string;
      readonly listener?: GitCommandListener;
    } = {},
  ) {}

  /**
   * @param prefix Synthetic rev-list lines parsed before git's output (the working-tree row:
   *   "<all zeros> <HEAD>").
   */
  open(
    repo: Repository,
    args: readonly string[],
    callbacks: LogCallbacks,
    prefix = '',
    stdin?: string,
  ): LogStream {
    const logId = nextLogId++;
    const oidBytes = repo.objectFormat === 'sha256' ? 32 : 20;
    if (this.options.workerPath) {
      try {
        return this.openInWorker(logId, repo, args, oidBytes, callbacks, prefix, stdin);
      } catch {
        // Fall back to in-process parsing if the worker cannot start.
      }
    }
    return this.openInProcess(logId, repo.runner, repo.root, args, oidBytes, callbacks, prefix, stdin);
  }

  private openInProcess(
    logId: number,
    runner: GitRunner,
    cwd: string,
    args: readonly string[],
    oidBytes: number,
    callbacks: LogCallbacks,
    prefix: string,
    stdin?: string,
  ): LogStream {
    const controller = new AbortController();
    const t0 = performance.now();
    const parser = new TopologyParser({
      oidBytes,
      onChunk: (chunk) => callbacks.onChunk({ ...chunk, logId }),
    });
    if (prefix) parser.push(new TextEncoder().encode(prefix));
    void runner
      .stream(
        { cwd, args, stdin, readOnly: true, label: 'Load history', signal: controller.signal },
        (data) => parser.push(data),
      )
      .then(
        () => {
          parser.end();
          callbacks.onEnd({ rowCount: parser.rowCount, durationMs: performance.now() - t0 });
        },
        (error: unknown) => {
          const cancelled = error instanceof GitError && error.kind === 'cancelled';
          callbacks.onEnd({
            rowCount: parser.rowCount,
            durationMs: performance.now() - t0,
            cancelled,
            error: cancelled ? undefined : error instanceof Error ? error.message : String(error),
          });
        },
      );
    return { logId, cancel: () => controller.abort() };
  }

  /**
   * Streams the history of several repositories as one log (see {@link MergedTopologyParser}):
   * one rev-list per source, run together; rows are tagged with their source's index.
   */
  openMerged(sources: readonly MergedSource[], oidBytes: number, callbacks: LogCallbacks): LogStream {
    const logId = nextLogId++;
    const specs: MergedSourceSpec[] = sources.map(({ repo, args, stdin }) => ({
      cwd: repo.root,
      args,
      stdin,
    }));
    if (this.options.workerPath && sources.length > 0) {
      try {
        const worker = this.ensureWorker();
        this.streams.set(logId, callbacks);
        const binary: GitBinary = sources[0]!.repo.runner.binary;
        worker.postMessage({
          type: 'openMerged',
          logId,
          git: { path: binary.path, versionRaw: binary.version.raw },
          sources: specs,
          oidBytes,
        } satisfies WorkerRequest);
        return {
          logId,
          cancel: () => {
            if (this.streams.has(logId))
              worker.postMessage({ type: 'cancel', logId } satisfies WorkerRequest);
          },
        };
      } catch {
        this.streams.delete(logId);
        // Fall back to in-process parsing if the worker cannot start.
      }
    }
    const controller = new AbortController();
    const t0 = performance.now();
    const parser = new MergedTopologyParser({
      oidBytes,
      sources: sources.length,
      onChunk: (chunk) => callbacks.onChunk({ ...chunk, logId }),
    });
    void streamMerged((index) => sources[index]!.repo.runner, specs, parser, controller.signal).then(
      (result) =>
        callbacks.onEnd(mergedEndInfo(parser.rowCount, result, sources.length, performance.now() - t0)),
      (error: unknown) =>
        callbacks.onEnd({
          rowCount: parser.rowCount,
          durationMs: performance.now() - t0,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return { logId, cancel: () => controller.abort() };
  }

  /** Starts the worker thread ahead of the first log (it takes tens of milliseconds to boot). */
  warmUp(): void {
    if (!this.options.workerPath) return;
    try {
      this.ensureWorker();
    } catch {
      // `open` falls back to in-process parsing.
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.options.workerPath!);
    worker.unref();
    worker.on('message', (message: WorkerResponse) => this.onWorkerMessage(message));
    worker.on('error', (error) => this.failAll(error instanceof Error ? error.message : String(error)));
    worker.on('exit', () => {
      this.worker = undefined;
      this.failAll('Log worker exited');
    });
    this.worker = worker;
    return worker;
  }

  private openInWorker(
    logId: number,
    repo: Repository,
    args: readonly string[],
    oidBytes: number,
    callbacks: LogCallbacks,
    prefix: string,
    stdin?: string,
  ): LogStream {
    const worker = this.ensureWorker();
    this.streams.set(logId, callbacks);
    const binary: GitBinary = repo.runner.binary;
    const request: WorkerRequest = {
      type: 'open',
      logId,
      git: { path: binary.path, versionRaw: binary.version.raw },
      cwd: repo.root,
      args,
      oidBytes,
      prefix,
      stdin,
    };
    worker.postMessage(request);
    return {
      logId,
      cancel: () => {
        if (this.streams.has(logId)) worker.postMessage({ type: 'cancel', logId } satisfies WorkerRequest);
      },
    };
  }

  private onWorkerMessage(message: WorkerResponse): void {
    switch (message.type) {
      case 'chunk':
        this.streams.get(message.logId)?.onChunk({ ...message.chunk, logId: message.logId });
        return;
      case 'end': {
        const callbacks = this.streams.get(message.logId);
        this.streams.delete(message.logId);
        callbacks?.onEnd(message.info);
        return;
      }
      case 'command-start':
        this.options.listener?.onCommandStart?.(message.event);
        return;
      case 'command-end':
        this.options.listener?.onCommandEnd?.(message.event);
        return;
    }
  }

  private failAll(error: string): void {
    for (const [, callbacks] of this.streams) callbacks.onEnd({ rowCount: 0, durationMs: 0, error });
    this.streams.clear();
  }

  dispose(): void {
    void this.worker?.terminate();
    this.worker = undefined;
    this.streams.clear();
  }
}
