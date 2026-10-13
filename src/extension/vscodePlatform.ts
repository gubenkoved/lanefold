import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Platform, PlatformDiff, PlatformMerge, PlatformMultiDiff } from '../core/backend/platform';
import type { Repository } from '../core/repo/repository';
import type { Disposable } from '../core/util/emitter';
import { paths } from '../core/util/paths';
import { DEFAULT_SETTINGS, type Settings } from '../shared/models';
import type { HostCommand } from '../shared/protocol';
import { emptyUri, revisionUri } from './revisionFs';

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('lanefold');
  return {
    confirm: config.get('confirm', DEFAULT_SETTINGS.confirm),
    animations: config.get('animations', DEFAULT_SETTINGS.animations),
    graphStyle: config.get('graph.style', DEFAULT_SETTINGS.graphStyle),
    density: config.get('graph.density', DEFAULT_SETTINGS.density),
    colors: config.get('graph.colors', DEFAULT_SETTINGS.colors),
    logOrder: config.get('log.order', DEFAULT_SETTINGS.logOrder),
    dateFormat: config.get('dateFormat', DEFAULT_SETTINGS.dateFormat),
    gravatar: config.get('avatars.gravatar', DEFAULT_SETTINGS.gravatar),
    defaultTabs: config.get('views.defaultTabs', DEFAULT_SETTINGS.defaultTabs),
  };
}

/** A path from the webview names a file of this repository, nothing else. */
function assertInside(repo: Repository, filePath: string): void {
  if (
    path.isAbsolute(filePath) ||
    paths.relativeInside(repo.root, path.resolve(repo.root, filePath)) === undefined
  )
    throw new Error(`${filePath} is not a file of this repository.`);
}

export class VscodePlatform implements Platform {
  readonly kind = 'vscode' as const;
  readonly logWorkerPath: string;
  readonly sequenceEditorPath: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** Registers a repository folder the way discovery does (once git is located). */
    private readonly discover?: (folder: string) => Promise<Repository | undefined>,
  ) {
    this.logWorkerPath = context.asAbsolutePath('dist/logWorker.js');
    this.sequenceEditorPath = context.asAbsolutePath('dist/scripts/sequence-editor.js');
  }

  async openRepository(folder: string): Promise<Repository | undefined> {
    return this.discover?.(folder);
  }

  async openDiff({ repo, title, left, right }: PlatformDiff): Promise<void> {
    const filePath = right?.path ?? left?.path;
    if (!filePath) return;
    for (const side of [left, right]) if (side) assertInside(repo, side.path);
    const leftUri = left ? revisionUri(repo, left) : emptyUri(repo, filePath);
    const rightUri = right ? revisionUri(repo, right) : emptyUri(repo, filePath);
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
  }

  async openMultiDiff({ repo, title, files, base, target }: PlatformMultiDiff): Promise<void> {
    for (const file of files) {
      assertInside(repo, file.path);
      if (file.oldPath !== undefined) assertInside(repo, file.oldPath);
    }
    const resources = files.map((file) => {
      const label = vscode.Uri.file(`${repo.root}/${file.path}`);
      const original =
        file.status === 'A' || base === undefined
          ? undefined
          : revisionUri(repo, { path: file.oldPath ?? file.path, rev: base });
      const modified = file.status === 'D' ? undefined : revisionUri(repo, { path: file.path, rev: target });
      return [label, original, modified] as const;
    });
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  }

  async openMergeEditor({
    repo,
    path: filePath,
    current,
    incoming,
    hasBase,
  }: PlatformMerge): Promise<boolean> {
    assertInside(repo, filePath);
    // VS Code's merge editor has no public API; its internal command is the one the built-in
    // Git extension uses. Without it, the caller falls back to the file with its markers.
    const commands = await vscode.commands.getCommands(false);
    if (!commands.includes('_open.mergeEditor')) return false;
    const side = (rev: string, label: PlatformMerge['current']) => ({
      uri: revisionUri(repo, { path: filePath, rev }),
      title: label.title,
      description: label.detail,
    });
    await vscode.commands.executeCommand('_open.mergeEditor', {
      base: hasBase ? revisionUri(repo, { path: filePath, rev: ':1' }) : emptyUri(repo, filePath),
      input1: side(':2', current),
      input2: side(':3', incoming),
      output: vscode.Uri.file(path.join(repo.root, filePath)),
    });
    return true;
  }

  async openFile(repo: Repository, filePath: string, rev?: string): Promise<void> {
    assertInside(repo, filePath);
    const uri = rev
      ? revisionUri(repo, { path: filePath, rev })
      : vscode.Uri.file(path.join(repo.root, filePath));
    await vscode.commands.executeCommand('vscode.open', uri);
  }

  async saveFile(repo: Repository, suggestedName: string, content: Uint8Array): Promise<string | undefined> {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(repo.root, suggestedName)),
      filters: { Patches: ['patch', 'diff'], 'All files': ['*'] },
      saveLabel: 'Save patch',
    });
    if (!target) return undefined;
    await vscode.workspace.fs.writeFile(target, content);
    return target.fsPath;
  }

  async pickFile(repo: Repository, title: string): Promise<string | undefined> {
    const [picked] =
      (await vscode.window.showOpenDialog({
        title,
        defaultUri: vscode.Uri.file(repo.root),
        canSelectMany: false,
        filters: { Patches: ['patch', 'diff', 'mbox', 'eml'], 'All files': ['*'] },
        openLabel: 'Choose',
      })) ?? [];
    return picked?.fsPath;
  }

  getSettings(): Settings {
    return readSettings();
  }

  onDidChangeSettings(listener: (settings: Settings) => void): Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('lanefold')) listener(readSettings());
    });
  }

  storageGet(key: string): unknown {
    return this.context.workspaceState.get(`lanefold.${key}`);
  }

  async storageSet(key: string, value: unknown): Promise<void> {
    await this.context.workspaceState.update(`lanefold.${key}`, value);
  }

  async runCommand(command: HostCommand, args?: unknown): Promise<void> {
    switch (command) {
      case 'openInEditor':
        await vscode.commands.executeCommand('lanefold.openInEditor', args);
        return;
      case 'openSettings':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          `@ext:${this.context.extension.id}`,
        );
        return;
      case 'showOutput':
        await vscode.commands.executeCommand('lanefold.showConsole');
        return;
      case 'selectRepository':
        await vscode.commands.executeCommand('lanefold.selectRepository');
        return;
      case 'clone':
        await vscode.commands.executeCommand('lanefold.clone');
        return;
      case 'init':
        await vscode.commands.executeCommand('lanefold.init');
        return;
      case 'openFolder': {
        const folder = (args as { path?: unknown } | undefined)?.path;
        // No folder named (the "No repository" page): VS Code asks which one.
        if (folder === undefined) return void (await vscode.commands.executeCommand('vscode.openFolder'));
        if (typeof folder !== 'string' || !path.isAbsolute(folder)) return;
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), {
          forceNewWindow: true,
        });
        return;
      }
    }
  }
}
