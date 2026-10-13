import * as vscode from 'vscode';
import type { Backend } from '../../core/backend/backend';
import type { Bootstrap } from '../../shared/protocol';
import { renderWebviewHtml, webviewOptions } from './html';
import { WebviewTransport, type VisibilitySource } from './transport';

/** Context key that scopes Lanefold's single-key shortcuts to the focused graph. */
export const GRAPH_FOCUSED_CONTEXT = 'lanefold.graphFocused';

/** The view whose focus report the context key follows (reports from two views can cross). */
let contextOwner: object | undefined;

/**
 * Connects one webview (the panel view or an editor tab) to the shared backend for its lifetime.
 */
export function attachWebview(options: {
  readonly webview: vscode.Webview;
  readonly visibility: VisibilitySource;
  readonly onDidDispose: vscode.Event<void>;
  readonly backend: Backend;
  readonly extensionUri: vscode.Uri;
  readonly bootstrap: Bootstrap;
  readonly gravatar: boolean;
  /** Called when the webview asks to retitle its host (editor tabs show the active view name). */
  readonly onTitle?: (title: string) => void;
  /** The main view (the panel): host commands fall back to it. */
  readonly primary?: boolean;
}): vscode.Disposable {
  const { webview, backend } = options;
  webview.options = webviewOptions(options.extensionUri);
  webview.html = renderWebviewHtml(webview, options.extensionUri, options.bootstrap, {
    gravatar: options.gravatar,
  });

  const transport = new WebviewTransport(webview, options.visibility);
  const endpoint = backend.connect(transport, { primary: options.primary });
  const offFocus = endpoint.on('ui.focus', ({ focused, graphFocused }) => {
    // A view that lost focus only clears the key if no other view took focus since.
    if (focused) contextOwner = endpoint;
    else if (contextOwner !== endpoint) return;
    void vscode.commands.executeCommand('setContext', GRAPH_FOCUSED_CONTEXT, graphFocused);
  });
  const offTitle = endpoint.on('ui.title', ({ title }) => options.onTitle?.(title));

  const session = vscode.Disposable.from(
    transport,
    { dispose: () => backend.disconnect(endpoint) },
    { dispose: offFocus },
    { dispose: offTitle },
  );
  const disposeListener = options.onDidDispose(() => {
    disposeListener.dispose();
    session.dispose();
    if (contextOwner !== endpoint) return;
    contextOwner = undefined;
    void vscode.commands.executeCommand('setContext', GRAPH_FOCUSED_CONTEXT, false);
  });
  return session;
}
