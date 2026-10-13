/**
 * Worker thread entry: runs `git rev-list` and parses its output off the extension host's main
 * thread, posting topology chunks back with their buffers transferred (zero-copy).
 */
import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { parseGitVersion } from '../git/binary';
import { GitError } from '../git/errors';
import { GitRunner } from '../git/runner';
import type { WorkerRequest, WorkerResponse } from './logEngine';
import { MergedTopologyParser } from './mergedParser';
import { mergedEndInfo, streamMerged } from './mergedStream';
import { TopologyParser } from './topologyParser';

const port = parentPort;
if (!port) throw new Error('logWorker must run in a worker thread');

const controllers = new Map<number, AbortController>();
const post = (message: WorkerResponse, transfer: ArrayBuffer[] = []) => port.postMessage(message, transfer);

port.on('message', (request: WorkerRequest) => {
  if (request.type === 'cancel') {
    controllers.get(request.logId)?.abort();
    return;
  }
  if (request.type === 'openMerged') {
    openMerged(request);
    return;
  }
  const { logId, git, cwd, args, oidBytes, prefix, stdin } = request;
  const runner = new GitRunner(
    { path: git.path, version: parseGitVersion(git.versionRaw) },
    {
      listener: {
        onCommandStart: (event) => post({ type: 'command-start', event }),
        onCommandEnd: (event) => post({ type: 'command-end', event }),
      },
    },
  );
  const controller = new AbortController();
  controllers.set(logId, controller);
  const t0 = performance.now();
  const parser = new TopologyParser({
    oidBytes,
    onChunk: (chunk) =>
      post({ type: 'chunk', logId, chunk }, [
        chunk.rowIds.buffer as ArrayBuffer,
        chunk.parentStart.buffer as ArrayBuffer,
        chunk.parentIds.buffer as ArrayBuffer,
        chunk.newOids.buffer as ArrayBuffer,
      ]),
  });
  if (prefix) parser.push(new TextEncoder().encode(prefix));
  void runner
    .stream({ cwd, args, stdin, readOnly: true, label: 'Load history', signal: controller.signal }, (data) =>
      parser.push(data),
    )
    .then(
      () => {
        parser.end();
        post({ type: 'end', logId, info: { rowCount: parser.rowCount, durationMs: performance.now() - t0 } });
      },
      (error: unknown) => {
        const cancelled = error instanceof GitError && error.kind === 'cancelled';
        post({
          type: 'end',
          logId,
          info: {
            rowCount: parser.rowCount,
            durationMs: performance.now() - t0,
            cancelled,
            error: cancelled ? undefined : error instanceof Error ? error.message : String(error),
          },
        });
      },
    )
    .finally(() => controllers.delete(logId));
});

/** Several repositories' rev-lists merged into one log (rows tagged with their repository). */
function openMerged(request: Extract<WorkerRequest, { type: 'openMerged' }>): void {
  const { logId, git, sources, oidBytes } = request;
  const runner = new GitRunner(
    { path: git.path, version: parseGitVersion(git.versionRaw) },
    {
      listener: {
        onCommandStart: (event) => post({ type: 'command-start', event }),
        onCommandEnd: (event) => post({ type: 'command-end', event }),
      },
    },
  );
  const controller = new AbortController();
  controllers.set(logId, controller);
  const t0 = performance.now();
  const parser = new MergedTopologyParser({
    oidBytes,
    sources: sources.length,
    onChunk: (chunk) =>
      post({ type: 'chunk', logId, chunk }, [
        chunk.rowIds.buffer as ArrayBuffer,
        chunk.parentStart.buffer as ArrayBuffer,
        chunk.parentIds.buffer as ArrayBuffer,
        chunk.newOids.buffer as ArrayBuffer,
        chunk.repos.buffer as ArrayBuffer,
      ]),
  });
  void streamMerged(() => runner, sources, parser, controller.signal)
    .then(
      (result) =>
        post({
          type: 'end',
          logId,
          info: mergedEndInfo(parser.rowCount, result, sources.length, performance.now() - t0),
        }),
      (error: unknown) =>
        post({
          type: 'end',
          logId,
          info: {
            rowCount: parser.rowCount,
            durationMs: performance.now() - t0,
            error: error instanceof Error ? error.message : String(error),
          },
        }),
    )
    .finally(() => controllers.delete(logId));
}
