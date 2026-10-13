import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitError } from '../core/git/errors';
import type { GitRunner } from '../core/git/runner';
import { cloneFolderName } from '../core/repo/clone';
import { redactCredentials } from '../shared/shell';

function describe(error: unknown): string {
  if (error instanceof GitError) {
    const line = error.stderr
      .split('\n')
      .map((text) => text.replace(/^(fatal|error): /, '').trim())
      .filter(Boolean)
      .at(-1);
    return line ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Asks for a URL and a parent folder, clones (cancellable), then offers to open the result. */
export async function cloneRepository(runner: GitRunner | undefined): Promise<void> {
  if (!runner) {
    void vscode.window.showErrorMessage(
      'Lanefold could not find git: install it or set "lanefold.git.path".',
    );
    return;
  }
  const url = (
    await vscode.window.showInputBox({
      title: 'Clone a repository',
      prompt: 'The URL (or path) of the repository to clone',
      placeHolder: 'https://github.com/owner/repository.git',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Enter the repository to clone'),
    })
  )?.trim();
  if (!url) return;
  const [parent] =
    (await vscode.window.showOpenDialog({
      title: 'Clone into which folder?',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Clone here',
    })) ?? [];
  if (!parent) return;
  const name = cloneFolderName(url);
  let target = path.join(parent.fsPath, name);
  for (let n = 2; existsSync(target); n++) target = path.join(parent.fsPath, `${name}-${n}`);

  const done = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Cloning ${redactCredentials(url)}…`,
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      try {
        await runner.run({
          cwd: parent.fsPath,
          args: ['clone', '--', url, target],
          signal: controller.signal,
          label: 'Clone',
        });
        return true;
      } catch (error) {
        // git removes the folder it created when a clone fails.
        if (!controller.signal.aborted)
          void vscode.window.showErrorMessage(`Clone failed: ${describe(error)}`);
        return false;
      }
    },
  );
  if (!done) return;
  const choice = await vscode.window.showInformationMessage(
    `Cloned into ${target}.`,
    'Open',
    'Open in New Window',
    'Add to Workspace',
  );
  const uri = vscode.Uri.file(target);
  if (choice === 'Open') await vscode.commands.executeCommand('vscode.openFolder', uri);
  else if (choice === 'Open in New Window')
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  else if (choice === 'Add to Workspace')
    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri });
}

/** Creates a repository in a workspace folder (or one the person picks), then opens it. */
export async function initRepository(
  runner: GitRunner | undefined,
  open: (folder: string) => Promise<unknown>,
): Promise<void> {
  if (!runner) {
    void vscode.window.showErrorMessage(
      'Lanefold could not find git: install it or set "lanefold.git.path".',
    );
    return;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const OTHER = 'Choose another folder…';
  let target: string | undefined;
  if (folders.length > 0) {
    const items: vscode.QuickPickItem[] = [
      ...folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath })),
      { label: OTHER },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Initialize a repository in…' });
    if (!pick) return;
    target = pick.label === OTHER ? undefined : pick.description;
  }
  if (!target) {
    const [chosen] =
      (await vscode.window.showOpenDialog({
        title: 'Initialize a repository in which folder?',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Initialize',
      })) ?? [];
    if (!chosen) return;
    target = chosen.fsPath;
  }
  if (existsSync(path.join(target, '.git'))) {
    void vscode.window.showInformationMessage(`${target} is already a git repository.`);
    await open(target);
    return;
  }
  try {
    await runner.run({ cwd: target, args: ['init'], label: 'Initialize repository' });
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not initialize a repository: ${describe(error)}`);
    return;
  }
  await open(target);
  void vscode.window.showInformationMessage(`Initialized a git repository in ${target}.`);
}
