import * as vscode from 'vscode';

/**
 * The tiny slice of VS Code's built-in Git extension API that Lanefold uses: the configured
 * git path and the repositories it has discovered. It is a soft dependency — when the built-in
 * extension is disabled, Lanefold falls back to its own discovery and `git` on PATH.
 */
export interface BuiltinGitRepository {
  readonly rootUri: vscode.Uri;
}

export interface BuiltinGitApi {
  readonly git: { readonly path: string };
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly repositories: readonly BuiltinGitRepository[];
  readonly onDidOpenRepository: vscode.Event<BuiltinGitRepository>;
  readonly onDidCloseRepository: vscode.Event<BuiltinGitRepository>;
}

interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): BuiltinGitApi;
}

export async function getBuiltinGitApi(): Promise<BuiltinGitApi | undefined> {
  const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
  if (!extension) return undefined;
  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    if (!exports?.enabled) return undefined;
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}
