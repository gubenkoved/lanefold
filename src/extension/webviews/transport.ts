import type * as vscode from 'vscode';
import type { RpcMessage, RpcTransport } from '../../shared/rpc';

const MAX_QUEUED = 2000;

export interface VisibilitySource {
  readonly visible: boolean;
  readonly onDidChangeVisibility: vscode.Event<unknown>;
}

/**
 * RPC transport over a VS Code webview. Messages sent while the view is hidden are queued and
 * flushed when it becomes visible again (VS Code may drop them otherwise). If the queue
 * overflows, events are dropped (responses never are) and the webview is told to resync.
 */
export class WebviewTransport implements RpcTransport, vscode.Disposable {
  private queue: RpcMessage[] = [];
  private droppedEvents = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly visibility: VisibilitySource,
  ) {
    this.disposables.push(visibility.onDidChangeVisibility(() => this.flush()));
  }

  get visible(): boolean {
    return this.visibility.visible;
  }

  send(message: RpcMessage): void {
    if (this.visibility.visible && this.queue.length === 0) {
      void this.webview.postMessage(message);
      return;
    }
    this.queue.push(message);
    if (this.queue.length > MAX_QUEUED) {
      this.queue = this.queue.filter((queued) => queued.kind !== 'evt');
      this.droppedEvents = true;
    }
  }

  onMessage(handler: (message: RpcMessage) => void): () => void {
    const subscription = this.webview.onDidReceiveMessage((message: unknown) => {
      // Only well-formed RPC messages get through (each handler validates its own parameters).
      if (!message || typeof message !== 'object') return;
      const kind = (message as { kind?: unknown }).kind;
      if (kind !== 'req' && kind !== 'res' && kind !== 'evt') return;
      handler(message as RpcMessage);
    });
    return () => subscription.dispose();
  }

  private flush(): void {
    if (!this.visibility.visible) return;
    const queued = this.queue;
    this.queue = [];
    for (const message of queued) void this.webview.postMessage(message);
    if (this.droppedEvents) {
      this.droppedEvents = false;
      void this.webview.postMessage({ kind: 'evt', event: 'app.resync', payload: {} } satisfies RpcMessage);
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.queue = [];
  }
}
