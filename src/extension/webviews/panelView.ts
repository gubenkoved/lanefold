import * as vscode from 'vscode';
import type { Backend } from '../../core/backend/backend';
import { readSettings } from '../vscodePlatform';
import { attachWebview } from './session';

export const PANEL_VIEW_ID = 'lanefold.panel';

/** The Lanefold view in the bottom panel (users can drag it to either sidebar). */
export class PanelViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly backend: Backend,
    private readonly extensionUri: vscode.Uri,
  ) {}

  static register(backend: Backend, extensionUri: vscode.Uri): vscode.Disposable {
    return vscode.window.registerWebviewViewProvider(
      PANEL_VIEW_ID,
      new PanelViewProvider(backend, extensionUri),
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    );
  }

  resolveWebviewView(view: vscode.WebviewView, context: vscode.WebviewViewResolveContext): void {
    attachWebview({
      webview: view.webview,
      visibility: view,
      onDidDispose: view.onDidDispose,
      backend: this.backend,
      extensionUri: this.extensionUri,
      bootstrap: { host: 'panel', restoredState: context.state },
      gravatar: readSettings().gravatar,
      primary: true,
      reveal: () => view.show(false),
    });
  }
}
