import * as vscode from 'vscode';
import type { Backend } from '../../core/backend/backend';
import { readSettings } from '../vscodePlatform';
import { attachWebview } from './session';

export const EDITOR_VIEW_TYPE = 'lanefold.editor';

/** Lanefold views popped out into editor tabs; restored by VS Code after a reload. */
export class EditorPanels implements vscode.Disposable {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly registration: vscode.Disposable;

  constructor(
    private readonly backend: Backend,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.registration = vscode.window.registerWebviewPanelSerializer(EDITOR_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state: unknown) => this.setup(panel, state),
    });
  }

  /** Opens a new editor tab; `state` lets the webview know which view to show. */
  open(state?: unknown): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      EDITOR_VIEW_TYPE,
      'Lanefold',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { retainContextWhenHidden: true, enableFindWidget: false },
    );
    this.setup(panel, state);
    return panel;
  }

  private setup(panel: vscode.WebviewPanel, state: unknown): void {
    // A tab's icon is drawn as an image, where the glyph's currentColor would be black: these are
    // copies of it in the themes' icon colours.
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'media', 'lanefold-light.svg'),
      dark: vscode.Uri.joinPath(this.extensionUri, 'media', 'lanefold-dark.svg'),
    };
    this.panels.add(panel);
    panel.onDidDispose(() => this.panels.delete(panel));
    attachWebview({
      webview: panel.webview,
      visibility: {
        get visible() {
          return panel.visible;
        },
        onDidChangeVisibility: panel.onDidChangeViewState,
      },
      onDidDispose: panel.onDidDispose,
      backend: this.backend,
      extensionUri: this.extensionUri,
      bootstrap: { host: 'editor', restoredState: state },
      gravatar: readSettings().gravatar,
      onTitle: (title) => {
        panel.title = title;
      },
      // Where it is: in front of its editor group, not moved to another.
      reveal: () => panel.reveal(undefined, false),
    });
  }

  dispose(): void {
    this.registration.dispose();
    for (const panel of this.panels) panel.dispose();
    this.panels.clear();
  }
}
