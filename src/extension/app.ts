import { chmodSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Backend } from '../core/backend/backend';
import { linesAt } from '../core/blame/blame';
import { ConsoleLog, combineListeners } from '../core/console/consoleLog';
import { findGit, isSupportedVersion, MIN_SUPPORTED_GIT } from '../core/git/binary';
import { AskpassServer, type AskpassRequest } from '../core/ipc/askpass';
import { GitRunner } from '../core/git/runner';
import { RepositoryRegistry } from '../core/repo/registry';
import type { ConsoleEntry } from '../shared/models';
import type { ThemeSnapshot } from '../shared/protocol';
import { branchChoices, hasUntrackedFiles, headStatus } from '../core/repo/branchChoices';
import type { Repository } from '../core/repo/repository';
import type { Operation } from '../shared/operations';
import { BlameController } from './blame/blameController';
import { getBuiltinGitApi } from './builtinGit';
import { cloneRepository, initRepository } from './cloneInit';
import { createConsoleChannel } from './consoleChannel';
import { editorLink, trackHostedEditor, type EditorLink } from './codeLinks';
import { locateFile } from './fileLocation';
import { RepoDiscovery } from './repoDiscovery';
import { RevisionFileSystem } from './revisionFs';
import { VscodePlatform } from './vscodePlatform';
import { EditorPanels } from './webviews/editorPanels';
import { pickBranchToDelete, pickBranchToSwitch, pickComparison, pickRebaseTarget } from './quickPicks';
import { StatusBar } from './statusBar';
import { PANEL_VIEW_ID, PanelViewProvider } from './webviews/panelView';

const ACTIVE_REPO_KEY = 'lanefold.activeRepo';

/** Wires the core services into VS Code. Owns everything created during activation. */
export class LanefoldApp implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly console = new ConsoleLog();
  private readonly channel: vscode.LogOutputChannel;
  private readonly registry: RepositoryRegistry;
  private readonly backend: Backend;
  private readonly editors: EditorPanels;
  private readonly blame: BlameController;
  private readonly commandListener;
  private discovery: RepoDiscovery | undefined;
  private runner: GitRunner | undefined;
  /** Settles once git is located and the workspace's repositories are discovered. */
  private ready: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    const { channel, listener } = createConsoleChannel();
    this.channel = channel;
    this.commandListener = combineListeners(this.console, listener);
    this.registry = new RepositoryRegistry(context.workspaceState.get<string>(ACTIVE_REPO_KEY));
    // Submodules and worktrees shown from Lanefold are registered like discovered repositories.
    const platform = new VscodePlatform(context, async (folder) => {
      await this.ready;
      return this.discovery?.open(folder);
    });
    this.backend = new Backend({ platform, registry: this.registry, console: this.console });
    this.editors = new EditorPanels(this.backend, context.extensionUri);
    this.blame = new BlameController(
      this.registry,
      (repo, sha) => this.revealCommit(repo, sha),
      () => this.ready,
    );

    this.disposables.push(
      channel,
      this.console,
      this.registry,
      this.backend,
      this.editors,
      PanelViewProvider.register(this.backend, context.extensionUri),
      RevisionFileSystem.register(
        (root) => this.registry.get(root),
        (listener) => {
          const subscription = this.registry.onDidChangeRepo(({ repo, kinds }) => {
            // Moving revisions (the index, HEAD, branches) live in the git dir.
            if ([...kinds].some((kind) => kind !== 'worktree')) listener(repo.id);
          });
          return { dispose: () => subscription.dispose() };
        },
      ),
      this.blame,
      trackHostedEditor(this.registry),
      new StatusBar(this.registry),
      this.registry.onDidChangeRepos(() => {
        void context.workspaceState.update(ACTIVE_REPO_KEY, this.registry.active?.id);
      }),
      vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (!event.affectsConfiguration('lanefold.git.path')) return;
        const choice = await vscode.window.showInformationMessage(
          'Lanefold uses the new git path after the window reloads.',
          'Reload Window',
        );
        if (choice) await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }),
      ...this.registerCommands(),
    );
  }

  /** Locates git and discovers repositories, off the activation path; commands wait for it. */
  start(): Promise<void> {
    this.ready = this.locateGit().catch((error: unknown) => {
      this.channel.error(error instanceof Error ? error.message : String(error));
    });
    return this.ready;
  }

  private async locateGit(): Promise<void> {
    const configuredPath = vscode.workspace.getConfiguration('lanefold').get<string | null>('git.path');
    const builtin = await getBuiltinGitApi();
    let runner: GitRunner;
    try {
      const binary = await findGit([configuredPath, builtin?.git.path]);
      runner = new GitRunner(binary, { listener: this.commandListener, env: await this.credentialEnv() });
      this.channel.info(`Using ${binary.version.raw} at ${binary.path}`);
      if (!isSupportedVersion(binary.version)) {
        const floor = `${MIN_SUPPORTED_GIT.major}.${MIN_SUPPORTED_GIT.minor}`;
        void vscode.window.showWarningMessage(
          `Lanefold needs git ${floor} or newer (found ${binary.version.raw}). Some features will not work.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.error(message);
      this.backend.setGit(undefined, message);
      return;
    }
    if (this.disposed) return;
    this.backend.setGit(runner);
    this.runner = runner;
    this.discovery = new RepoDiscovery(runner, this.registry, this.channel);
    this.disposables.push(this.discovery);
    await this.discovery.start(builtin);
  }

  private registerCommands(): vscode.Disposable[] {
    const command = (id: string, run: (...args: unknown[]) => unknown) =>
      vscode.commands.registerCommand(id, run);
    return [
      // The view in use (an editor tab, when Lanefold was last used in one), else the panel.
      command('lanefold.open', () => this.toView()),
      command('lanefold.openInEditor', (state?: unknown) => this.editors.open(state)),
      command('lanefold.refresh', () => this.backend.sendCommand('refresh')),
      command('lanefold.undo', () => this.inView('undo')),
      command('lanefold.redo', () => this.inView('redo')),
      command('lanefold.showConsole', () => {
        this.channel.show(true);
        this.backend.sendCommand('showConsole');
      }),
      command('lanefold.showStatistics', () => this.inView('showStatistics')),
      command('lanefold.clone', async () => {
        await this.ready;
        await cloneRepository(this.runner);
      }),
      command('lanefold.init', async () => {
        await this.ready;
        await initRepository(this.runner, (folder) => this.discovery?.open(folder) ?? Promise.resolve());
      }),
      command('lanefold.fileHistory', async (uri?: unknown) => {
        await this.ready;
        await this.fileHistory(uri);
      }),
      command('lanefold.lineHistory', async () => {
        await this.ready;
        await this.lineHistory();
      }),
      command('lanefold.links.copy', async () => {
        await this.ready;
        await this.linkSelection('copy');
      }),
      command('lanefold.links.open', async () => {
        await this.ready;
        await this.linkSelection('open');
      }),
      command('lanefold.switchBranch', async () => {
        const repo = await this.activeRepo();
        if (!repo) return;
        const target = await pickBranchToSwitch(repo);
        if (target === 'create')
          await this.run(repo, { kind: 'createBranch', name: '', at: 'HEAD', checkout: true });
        else if (target) await this.run(repo, { kind: 'checkout', target });
      }),
      command('lanefold.createBranch', async () => {
        const repo = await this.activeRepo();
        if (repo) await this.run(repo, { kind: 'createBranch', name: '', at: 'HEAD', checkout: true });
      }),
      command('lanefold.deleteBranch', async () => {
        const repo = await this.activeRepo();
        if (!repo) return;
        const choice = await pickBranchToDelete(repo);
        if (choice?.kind === 'branch') await this.run(repo, { kind: 'deleteBranch', name: choice.name });
        // From its remote: always reviewed, Undo cannot bring it back.
        else if (choice) await this.run(repo, { kind: 'deleteRemoteBranch', name: choice.name }, true);
      }),
      command('lanefold.deleteGoneBranches', async () => {
        const repo = await this.activeRepo();
        if (!repo) return;
        // As of the last fetch: one that prunes learns which upstreams were deleted since.
        const gone = (await branchChoices(repo)).filter((choice) => choice.kind === 'branch' && choice.gone);
        if (gone.length > 0) {
          await this.run(repo, { kind: 'deleteBranches', names: gone.map((choice) => choice.name) }, true);
          return;
        }
        const fetch = await vscode.window.showInformationMessage(
          'Lanefold: no branch’s upstream is gone, as of the last fetch. Fetch and prune to learn which branches were deleted on the remote since.',
          'Fetch and Prune',
        );
        if (fetch) await this.run(repo, { kind: 'fetch', prune: true });
      }),
      command('lanefold.fetch', async () => {
        const repo = await this.activeRepo();
        if (repo) await this.run(repo, { kind: 'fetch' });
      }),
      command('lanefold.pull', async () => {
        const repo = await this.activeRepo();
        if (!repo) return;
        // With commits of its own the branch has diverged: rebasing them is reviewed first.
        const { ahead } = await headStatus(repo);
        await this.run(repo, { kind: 'pull', mode: ahead > 0 ? 'rebase' : 'ff-only' }, ahead > 0);
      }),
      command('lanefold.push', async () => {
        const repo = await this.activeRepo();
        if (repo) await this.run(repo, { kind: 'push' });
      }),
      command('lanefold.rebaseInteractive', async () => {
        const repo = await this.activeRepo();
        if (!repo) return;
        // The history editor opens on the commits the target lacks, to arrange before they move.
        const onto = await pickRebaseTarget(repo);
        if (onto) await this.runInView(repo, 'startRebaseOnto', { repoId: repo.id, onto });
      }),
      command('lanefold.stash', async () => {
        const repo = await this.activeRepo();
        if (!repo) return;
        // Untracked files too when there are any, as Lanefold's own Stash buttons do.
        await this.run(repo, { kind: 'stashPush', includeUntracked: await hasUntrackedFiles(repo) });
      }),
      command('lanefold.compare', async () => {
        const repo = await this.activeRepo();
        if (!repo) return;
        const picked = await pickComparison(repo);
        if (picked) await this.runInView(repo, 'openCompare', { repoId: repo.id, ...picked });
      }),
      command('lanefold.selectRepository', async () => {
        await this.ready;
        const repos = this.registry.all;
        if (repos.length === 0) {
          void vscode.window.showInformationMessage('Lanefold: no git repositories found in this workspace.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          repos.map((repo) => ({
            label: repo.name,
            description: repo.root,
            picked: repo.id === this.registry.active?.id,
            id: repo.id,
          })),
          { placeHolder: 'Select the repository Lanefold shows' },
        );
        if (pick) this.registry.setActive(pick.id);
      }),
    ];
  }

  /**
   * Environment that routes git's and ssh's credential prompts to VS Code input boxes (via
   * Lanefold's askpass helper). Empty if the bridge cannot start: git then relies on its
   * credential helpers alone.
   */
  private async credentialEnv(): Promise<Record<string, string>> {
    try {
      const server = await AskpassServer.start((request, signal) => this.ask(request, signal));
      if (this.disposed) {
        server.dispose();
        return {};
      }
      this.disposables.push({ dispose: () => server.dispose() });
      const script = this.context.asAbsolutePath('dist/scripts/askpass.sh');
      try {
        chmodSync(script, 0o755);
      } catch {
        // Read-only install: the packaged file keeps its mode.
      }
      return server.env(
        script,
        this.context.asAbsolutePath('dist/scripts/askpass-main.js'),
        process.execPath,
      );
    } catch (error) {
      this.channel.warn(
        `Credential prompts are unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {};
    }
  }

  private async ask({ prompt, kind }: AskpassRequest, signal: AbortSignal): Promise<string | undefined> {
    const text = prompt.trim().replace(/:\s*$/, '');
    if (kind === 'confirm') {
      const choice = await vscode.window.showWarningMessage(
        text,
        { modal: true, detail: 'Git is connecting to a remote for Lanefold.' },
        'Yes',
        'No',
      );
      return choice === 'Yes' ? 'yes' : choice === 'No' ? 'no' : undefined;
    }
    // The prompt closes when the git process that asked is gone (the operation was cancelled).
    const cancel = new vscode.CancellationTokenSource();
    signal.addEventListener('abort', () => cancel.cancel(), { once: true });
    try {
      return await vscode.window.showInputBox(
        {
          title: kind === 'passphrase' ? 'SSH key passphrase' : 'Git credentials',
          prompt: text,
          password: kind === 'password' || kind === 'passphrase',
          ignoreFocusOut: true,
        },
        cancel.token,
      );
    } finally {
      cancel.dispose();
    }
  }

  /** The repository commands act on (the active one), or undefined after saying there is none. */
  private async activeRepo(): Promise<Repository | undefined> {
    await this.ready;
    const repo = this.registry.active;
    if (!repo) void vscode.window.showInformationMessage('Lanefold: no git repository is open.');
    return repo;
  }

  /**
   * Runs an operation from the command palette the way a button in Lanefold does: planned,
   * reviewed when it needs to be, with Undo in its confirmation.
   */
  private run(repo: Repository, operation: Operation, review = false): Promise<void> {
    return this.runInView(repo, 'runOperation', { repoId: repo.id, operation, review });
  }

  /** Shows a commit in the Lanefold graph (opening the panel and waiting for it if needed). */
  private revealCommit(repo: Repository, sha: string): Promise<void> {
    return this.runInView(repo, 'revealCommit', { repoId: repo.id, sha });
  }

  /**
   * Runs a webview command (Undo, Redo) in the view the person was using, without moving focus
   * there; with no Lanefold view on screen, in the one brought forward for it (see
   * {@link toView}): once, so it shows its outcome.
   */
  private async inView(command: string): Promise<void> {
    if (this.backend.sendCommand(command)) return;
    await this.toView(command);
  }

  /** Runs a webview command on `repo` in the Lanefold view in use (see {@link toView}). */
  private async runInView(repo: Repository, command: string, args: unknown): Promise<void> {
    this.registry.setActive(repo.id);
    await this.toView(command, args);
  }

  /**
   * Brings the Lanefold view in use forward, with keyboard focus, and runs `command` there (if
   * any): a view on screen, the panel or an editor tab, so nothing moves while Lanefold is in
   * sight; else the one used last, wherever it is hidden; else the panel, opened for it (waiting
   * for its webview if needed).
   */
  private async toView(command?: string, args?: unknown): Promise<void> {
    const view = this.backend.viewInUse();
    if (view) {
      this.backend.showView(view);
      if (command) this.backend.sendCommand(command, args, view);
      return;
    }
    await this.openPanel();
    if (command) this.backend.sendCommand(command, args, 'primary');
  }

  /** Shows the panel and waits (a while) for its webview to be ready. */
  private async openPanel(): Promise<void> {
    await vscode.commands.executeCommand(`${PANEL_VIEW_ID}.focus`);
    if (this.backend.primaryReady) return;
    await new Promise<void>((resolve) => {
      const subscription = this.backend.onDidConnect(() => {
        if (!this.backend.primaryReady) return;
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      });
      const timer = setTimeout(() => {
        subscription.dispose();
        resolve();
      }, 8000);
    });
  }

  /** The history of a file or folder (from the Explorer, an editor tab, or the active editor). */
  private async fileHistory(arg?: unknown): Promise<void> {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    const location = uri && locateFile(this.registry, uri);
    if (!location) {
      void vscode.window.showInformationMessage(
        'Lanefold: choose a file or folder in a git repository to see its history.',
      );
      return;
    }
    await this.runInView(location.repo, 'openFileHistory', {
      repoId: location.repo.id,
      path: location.path,
      rev: location.rev,
    });
  }

  /** The history of the selected lines of the active editor (`git log -L`). */
  private async lineHistory(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const location = editor && locateFile(this.registry, editor.document.uri);
    if (!editor || !location?.path) {
      void vscode.window.showInformationMessage(
        'Lanefold: select lines in a file of a git repository first.',
      );
      return;
    }
    const { selection } = editor;
    let start = selection.start.line + 1;
    let end = selection.end.line + 1;
    // A selection of whole lines ends at the start of the next one.
    if (end > start && selection.end.character === 0) end -= 1;
    if (!location.rev) {
      try {
        const unsaved = editor.document.isDirty ? editor.document.getText() : undefined;
        ({ start, end } = await linesAt(location.repo, 'HEAD', location.path, start, end, unsaved));
      } catch {
        void vscode.window.showInformationMessage(
          `Lanefold: ${path.basename(location.path)} has no history yet (it is not committed).`,
        );
        return;
      }
    }
    await this.runInView(location.repo, 'openLineHistory', {
      repoId: location.repo.id,
      path: location.path,
      start,
      end,
      rev: location.rev,
    });
  }

  /** Copy Permalink and Open on Remote: the selected lines of the active editor on the code host. */
  private async linkSelection(action: 'copy' | 'open'): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Lanefold: open a file of a git repository first.');
      return;
    }
    let link: EditorLink;
    try {
      link = await editorLink(this.registry, editor);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Lanefold: could not make the link: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if ('reason' in link) {
      void vscode.window.showInformationMessage(`Lanefold: ${link.reason}`);
      return;
    }
    if (action === 'open') await vscode.env.openExternal(vscode.Uri.parse(link.url, true));
    else {
      await vscode.env.clipboard.writeText(link.url);
      vscode.window.setStatusBarMessage(`$(link) Copied a link to ${link.host.name}`, 4000);
    }
    if (link.warning) void vscode.window.showWarningMessage(`Lanefold: ${link.warning}`);
  }

  /** Hooks for the VS Code integration tests (exported only in test mode). */
  testing(): LanefoldTestingApi {
    return {
      repositories: () => this.registry.all.map((repo) => repo.root),
      readyWebviews: () => this.backend.readyConnections.length,
      viewInUse: () => {
        const view = this.backend.viewInUse();
        return view && (this.backend.isPrimary(view) ? 'panel' : 'editor');
      },
      captureTheme: async () => {
        const endpoint = this.backend.readyConnections.at(-1);
        if (!endpoint) throw new Error('No webview is connected');
        return endpoint.call('debug.theme');
      },
      consoleHistory: () => this.console.history(),
      blame: (uri) => this.blame.inspect(uri),
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables.reverse()) disposable.dispose();
  }
}

export interface LanefoldTestingApi {
  repositories(): string[];
  readyWebviews(): number;
  /** Where a command that needs a Lanefold view would go now (undefined: the panel, opened for it). */
  viewInUse(): 'panel' | 'editor' | undefined;
  captureTheme(): Promise<ThemeSnapshot>;
  consoleHistory(): readonly ConsoleEntry[];
  blame(uri: string): { lines: number; summaries: string[] } | undefined;
}
