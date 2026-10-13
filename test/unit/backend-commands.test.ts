import { afterEach, describe, expect, it } from 'vitest';
import { Backend } from '../../src/core/backend/backend';
import type { Platform } from '../../src/core/backend/platform';
import { ConsoleLog } from '../../src/core/console/consoleLog';
import { RepositoryRegistry } from '../../src/core/repo/registry';
import type { RpcMessage, RpcTransport } from '../../src/shared/rpc';

/** A connected webview as the backend sees it. */
class FakeView implements RpcTransport {
  visible = true;
  private readonly received: RpcMessage[] = [];
  private handler: ((message: RpcMessage) => void) | undefined;

  send(message: RpcMessage): void {
    this.received.push(message);
  }

  onMessage(handler: (message: RpcMessage) => void): () => void {
    this.handler = handler;
    return () => (this.handler = undefined);
  }

  /** An event from the webview's side. */
  fire(event: string, payload: unknown = {}): void {
    this.handler?.({ kind: 'evt', event, payload });
  }

  commands(): string[] {
    return this.received.flatMap((message) =>
      message.kind === 'evt' && message.event === 'command.run'
        ? [(message.payload as { command: string }).command]
        : [],
    );
  }
}

describe('host commands run in one view', () => {
  const registry = new RepositoryRegistry();
  const platform = { onDidChangeSettings: () => ({ dispose: () => undefined }) } as unknown as Platform;
  const backend = new Backend({ platform, registry, console: new ConsoleLog() });
  afterEach(() => {
    for (const endpoint of backend.readyConnections) backend.disconnect(endpoint);
  });

  function view(options: { primary?: boolean } = {}): FakeView {
    const transport = new FakeView();
    backend.connect(transport, options);
    transport.fire('ui.ready');
    return transport;
  }

  it('an Undo goes to the view that had focus last, not to every view', () => {
    const panel = view({ primary: true });
    const editor = view();
    editor.fire('ui.focus', { focused: true, graphFocused: true });
    // The command palette takes focus before the command runs: the view stays the target.
    editor.fire('ui.focus', { focused: false, graphFocused: false });

    expect(backend.sendCommand('undo')).toBe(true);
    expect(editor.commands()).toEqual(['undo']);
    expect(panel.commands()).toEqual([]);
  });

  it('never runs in a hidden view (it would run later, when shown): the panel takes it', () => {
    const panel = view({ primary: true });
    const editor = view();
    editor.fire('ui.focus', { focused: true, graphFocused: true });
    editor.visible = false;

    expect(backend.sendCommand('undo')).toBe(true);
    expect(panel.commands()).toEqual(['undo']);
    expect(editor.commands()).toEqual([]);
  });

  it('reports when no view is on screen, so the host can open the panel first', () => {
    const panel = view({ primary: true });
    panel.visible = false;
    expect(backend.sendCommand('undo')).toBe(false);
    expect(panel.commands()).toEqual([]);
    // Once the panel opens, the command goes there.
    panel.visible = true;
    expect(backend.sendCommand('undo', undefined, 'primary')).toBe(true);
    expect(panel.commands()).toEqual(['undo']);
  });
});
