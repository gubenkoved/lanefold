export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (value: T) => void;

/** Minimal typed event emitter (the core layer cannot use vscode.EventEmitter). */
export class Emitter<T> implements Disposable {
  private listeners = new Set<Listener<T>>();

  /** Subscribes to the event; dispose the result to unsubscribe. */
  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error('[lanefold] event listener failed', error);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** Collects disposables and disposes them together (in reverse order). */
export class DisposableStore implements Disposable {
  private items: Disposable[] = [];

  add<T extends Disposable>(item: T): T {
    this.items.push(item);
    return item;
  }

  dispose(): void {
    const items = this.items.reverse();
    this.items = [];
    for (const item of items) {
      try {
        item.dispose();
      } catch (error) {
        console.error('[lanefold] dispose failed', error);
      }
    }
  }
}

/** Debounces calls, accumulating arguments into a set that is flushed after `ms` of quiet. */
export function debounceCollect<T>(
  ms: number,
  flush: (items: Set<T>) => void,
): ((item: T) => void) & Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = new Set<T>();
  const push = (item: T) => {
    pending.add(item);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const items = pending;
      pending = new Set();
      flush(items);
    }, ms);
  };
  return Object.assign(push, {
    dispose: () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = new Set();
    },
  });
}
