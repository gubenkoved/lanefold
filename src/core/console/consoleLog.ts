import type { ConsoleEntry } from '../../shared/models';
import type { GitCommandEnd, GitCommandListener, GitCommandStart } from '../git/runner';
import { Emitter } from '../util/emitter';

/** In-memory history of every git command Lanefold ran (the Git Console). */
export class ConsoleLog implements GitCommandListener {
  private readonly entries = new Map<number, ConsoleEntry>();
  private readonly onDidChangeEmitter = new Emitter<ConsoleEntry>();
  /** Fires when a command starts or finishes. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly capacity = 1000) {}

  history(): ConsoleEntry[] {
    return [...this.entries.values()];
  }

  clear(): void {
    this.entries.clear();
  }

  onCommandStart(event: GitCommandStart): void {
    this.put({
      id: event.id,
      cwd: event.cwd,
      args: event.args,
      label: event.label,
      readOnly: event.readOnly,
      background: event.background || undefined,
      startedAt: event.startedAt,
      state: 'running',
    });
  }

  onCommandEnd(event: GitCommandEnd): void {
    const state = event.cancelled ? 'cancelled' : event.failed ? 'error' : 'ok';
    this.put({
      id: event.id,
      cwd: event.cwd,
      args: event.args,
      label: event.label,
      readOnly: event.readOnly,
      background: event.background || undefined,
      startedAt: event.startedAt,
      state,
      durationMs: Math.round(event.durationMs * 10) / 10,
      exitCode: event.exitCode,
      stderr: event.stderr || undefined,
      stdoutTail: event.stdoutTail || undefined,
    });
  }

  private put(entry: ConsoleEntry): void {
    // Replacing keeps insertion order by start time (an entry is first added when it starts).
    this.entries.set(entry.id, entry);
    if (this.entries.size > this.capacity) this.evict();
    this.onDidChangeEmitter.fire(entry);
  }

  /** Drops the oldest finished read-only query first, so state-changing commands are kept longest. */
  private evict(): void {
    for (const [id, existing] of this.entries) {
      if (existing.readOnly && existing.state !== 'running') {
        this.entries.delete(id);
        return;
      }
    }
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

/** Fans command events out to several listeners (console log, output channel, worker relay). */
export function combineListeners(...listeners: GitCommandListener[]): GitCommandListener {
  return {
    onCommandStart: (event) => listeners.forEach((l) => l.onCommandStart?.(event)),
    onCommandEnd: (event) => listeners.forEach((l) => l.onCommandEnd?.(event)),
  };
}
