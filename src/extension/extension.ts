import * as vscode from 'vscode';
import { LanefoldApp, type LanefoldTestingApi } from './app';

export interface LanefoldExtensionApi {
  /** Resolves once git has been located and the workspace repositories discovered. */
  readonly ready: Promise<void>;
  /** Present only when the extension runs under the VS Code test runner. */
  readonly testing?: LanefoldTestingApi;
}

let app: LanefoldApp | undefined;

export function activate(context: vscode.ExtensionContext): LanefoldExtensionApi {
  app = new LanefoldApp(context);
  context.subscriptions.push(app);
  // Locating git and scanning repositories happens off the activation path.
  const ready = app.start();
  return {
    ready,
    testing: context.extensionMode === vscode.ExtensionMode.Test ? app.testing() : undefined,
  };
}

export function deactivate(): void {
  app = undefined;
}
