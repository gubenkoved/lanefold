import { afterEach, describe, expect, it } from 'vitest';
import { Backend, type HostEndpoint } from '../../src/core/backend/backend';
import type { Platform } from '../../src/core/backend/platform';
import { ConsoleLog } from '../../src/core/console/consoleLog';
import { RepositoryRegistry } from '../../src/core/repo/registry';
import type { RpcMessage, RpcTransport } from '../../src/shared/rpc';

/** A connected webview as the backend sees it. */
class FakeView implements RpcTransport {
  visible = true;
  /** How often its host was asked to bring it forward. */
  revealed = 0;
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
    endpoints.clear();
  });

  const endpoints = new Map<FakeView, HostEndpoint>();
  function view(options: { primary?: boolean } = {}): FakeView {
    const transport = new FakeView();
    // Its host brings it forward: on screen from then on.
    const reveal = () => {
      transport.visible = true;
      transport.revealed++;
    };
    endpoints.set(transport, backend.connect(transport, { ...options, reveal }));
    transport.fire('ui.ready');
    return transport;
  }
  /** The view a command that needs one would go to. */
  const inUse = () => [...endpoints].find(([, endpoint]) => endpoint === backend.viewInUse())?.[0];
  const focus = (transport: FakeView) => transport.fire('ui.focus', { focused: true, graphFocused: true });

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

  describe('the view in use, where a command that needs a view goes', () => {
    it('is the view on screen that had focus last: an editor tab rather than the panel', () => {
      const panel = view({ primary: true });
      const editor = view();
      focus(panel);
      focus(editor);
      expect(inUse()).toBe(editor);
      focus(panel);
      expect(inUse()).toBe(panel);
    });

    it('is a view on screen rather than one used later that is hidden now: nothing moves', () => {
      const panel = view({ primary: true });
      const editor = view();
      focus(editor);
      editor.visible = false;
      expect(inUse()).toBe(panel);
      // With the panel closed too, an editor tab on screen that never had focus.
      const other = view();
      panel.visible = false;
      expect(inUse()).toBe(other);
    });

    it('is the view used last when none is on screen: brought forward, it takes the command', () => {
      const panel = view({ primary: true });
      const editor = view();
      focus(panel);
      focus(editor);
      panel.visible = false;
      editor.visible = false;
      expect(inUse()).toBe(editor);

      const target = backend.viewInUse()!;
      backend.showView(target);
      expect(backend.sendCommand('startRebaseOnto', undefined, target)).toBe(true);
      expect([editor.revealed, editor.visible, editor.commands()]).toEqual([1, true, ['startRebaseOnto']]);
      expect([panel.revealed, panel.commands()]).toEqual([0, []]);
    });

    it('forgets a view that was closed, and is none when no view was used: the panel opens then', () => {
      const panel = view({ primary: true });
      const editor = view();
      focus(editor);
      panel.visible = false;
      backend.disconnect(endpoints.get(editor)!);
      endpoints.delete(editor);
      expect(inUse()).toBeUndefined();
      expect(backend.sendCommand('undo', undefined, endpoints.get(panel))).toBe(true);
    });
  });
});
