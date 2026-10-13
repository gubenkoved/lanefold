import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitRunner } from '../core/git/runner';
import type { RepositoryRegistry } from '../core/repo/registry';
import { Repository } from '../core/repo/repository';
import { paths } from '../core/util/paths';
import type { BuiltinGitApi } from './builtinGit';
import { watchRepository } from './repoWatcher';

/**
 * Finds repositories in the workspace folders and those the built-in Git extension knows about
 * (nested repos, submodules), registers them and keeps a watcher per repository.
 */
export class RepoDiscovery implements vscode.Disposable {
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly opening = new Set<string>();

  constructor(
    private readonly runner: GitRunner,
    private readonly registry: RepositoryRegistry,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async start(builtin: BuiltinGitApi | undefined): Promise<void> {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
        for (const folder of event.removed) this.removeUnder(folder.uri.fsPath);
        await Promise.all(event.added.map((folder) => this.open(folder.uri.fsPath)));
      }),
    );
    const folders = vscode.workspace.workspaceFolders ?? [];
    const opened = folders.map((folder) => this.open(folder.uri.fsPath));

    if (builtin) {
      this.disposables.push(
        builtin.onDidOpenRepository((repo) => void this.open(repo.rootUri.fsPath)),
        // A repository VS Code closed because its folder is gone: forget it (and its watchers).
        builtin.onDidCloseRepository((repo) => {
          if (!existsSync(repo.rootUri.fsPath)) this.removeUnder(repo.rootUri.fsPath);
        }),
      );
      opened.push(...builtin.repositories.map((repo) => this.open(repo.rootUri.fsPath)));
    }
    await Promise.all(opened);
  }

  async open(folder: string): Promise<Repository | undefined> {
    const key = path.resolve(folder);
    if (this.opening.has(key)) return undefined;
    this.opening.add(key);
    try {
      const repo = await Repository.open(this.runner, key);
      if (repo && this.registry.add(repo)) {
        this.log.info(`Opened repository ${repo.root}`);
        this.watchers.set(
          repo.id,
          watchRepository(repo, (kinds) => this.registry.notifyChange(repo.id, kinds)),
        );
      }
      return repo;
    } catch (error) {
      this.log.warn(
        `Could not open repository at ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    } finally {
      this.opening.delete(key);
    }
  }

  private removeUnder(folder: string): void {
    for (const repo of this.registry.all) {
      if (paths.relativeInside(folder, repo.root) !== undefined) {
        this.watchers.get(repo.id)?.dispose();
        this.watchers.delete(repo.id);
        this.registry.remove(repo.id);
      }
    }
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) watcher.dispose();
    this.watchers.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
