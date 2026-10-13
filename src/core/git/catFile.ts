import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { GitRunner } from './runner';

/** An object as `git cat-file --batch` returns it. */
export interface GitObject {
  /** "commit", "tag", "tree" or "blob". */
  readonly type: string;
  readonly data: Uint8Array;
}

interface PendingRead {
  readonly name: string;
  resolve(value: GitObject | undefined): void;
  reject(error: Error): void;
}

const IDLE_TIMEOUT_MS = 60_000;

/**
 * A long-lived `git cat-file --batch` process: one spawn serves thousands of object reads
 * (commit metadata pages, file contents for diffs). Requests are pipelined; responses arrive in
 * request order. The process exits after a minute of inactivity and restarts on demand.
 */
export class CatFileReader {
  private child: ChildProcessWithoutNullStreams | undefined;
  private queue: PendingRead[] = [];
  private buffer = new Uint8Array(0);
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly runner: GitRunner,
    private readonly cwd: string,
    private readonly options: { readonly mailmap?: boolean } = {},
  ) {}

  /** Reads an object's raw contents; `undefined` if it does not exist. */
  async read(name: string): Promise<Uint8Array | undefined> {
    return (await this.readObject(name))?.data;
  }

  /** Reads an object's type and raw contents; `undefined` if it does not exist. */
  readObject(name: string): Promise<GitObject | undefined> {
    if (this.disposed) return Promise.reject(new Error('CatFileReader disposed'));
    if (/[\n\r]/.test(name)) return Promise.reject(new Error('Invalid object name'));
    return new Promise((resolve, reject) => {
      const child = this.ensureProcess();
      this.queue.push({ name, resolve, reject });
      child.stdin.write(`${name}\n`);
      this.touch();
    });
  }

  readMany(names: readonly string[]): Promise<(Uint8Array | undefined)[]> {
    return Promise.all(names.map((name) => this.read(name)));
  }

  readObjects(names: readonly string[]): Promise<(GitObject | undefined)[]> {
    return Promise.all(names.map((name) => this.readObject(name)));
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  /** Starts the process ahead of the first read (spawning takes a few milliseconds). */
  warmUp(): void {
    this.ensureProcess();
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const args = ['cat-file', ...(this.options.mailmap ? ['--use-mailmap'] : []), '--batch'];
    const child = this.runner.spawnProcess({ cwd: this.cwd, args, readOnly: true, label: 'Object reader' });
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.on('close', () => {
      if (this.child === child) this.child = undefined;
      const pending = this.queue;
      this.queue = [];
      this.buffer = new Uint8Array(0);
      for (const read of pending) read.reject(new Error('git cat-file exited'));
    });
    child.on('error', () => undefined);
    child.stdin.on('error', () => undefined);
    this.child = child;
    return child;
  }

  private onData(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    this.drain();
  }

  /** Parses as many complete responses as the buffer holds. */
  private drain(): void {
    let offset = 0;
    const buf = this.buffer;
    while (this.queue.length > 0) {
      const newline = buf.indexOf(10, offset);
      if (newline < 0) break;
      const header = new TextDecoder().decode(buf.subarray(offset, newline));
      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
        this.queue.shift()!.resolve(undefined);
        offset = newline + 1;
        continue;
      }
      // "<oid> <type> <size>"
      const [, type = '', sizeField = ''] = header.split(' ');
      const size = Number(sizeField);
      const end = newline + 1 + size;
      if (!Number.isFinite(size) || buf.length < end + 1) break;
      this.queue.shift()!.resolve({ type, data: buf.slice(newline + 1, end) });
      offset = end + 1; // skip the trailing newline
    }
    this.buffer = offset === 0 ? buf : buf.slice(offset);
  }

  private stop(): void {
    const child = this.child;
    this.child = undefined;
    child?.stdin.end();
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.stop();
  }
}
