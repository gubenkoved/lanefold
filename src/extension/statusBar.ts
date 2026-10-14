import * as vscode from 'vscode';
import { readOpState } from '../core/ops/opState';
import { headStatus } from '../core/repo/branchChoices';
import type { RepositoryRegistry } from '../core/repo/registry';
import type { RepoChangeKind } from '../shared/models';
import type { OpState } from '../shared/operations';

/** Repository changes that can change what the item says. */
const REFRESH_ON: readonly RepoChangeKind[] = ['head', 'refs', 'opState', 'index', 'config'];

const short = (sha: string | undefined) => (sha ? sha.slice(0, 7) : '');

/** What a stopped operation is, for the status bar: an icon and a few words. */
function describe(state: OpState): { icon: string; text: string } {
  const conflicts = state.conflicts.length;
  const progress = state.step && state.total ? ` ${state.step}/${state.total}` : '';
  const suffix = conflicts > 0 ? ` · ${conflicts} conflict${conflicts === 1 ? '' : 's'}` : '';
  switch (state.kind) {
    case 'merge':
      return { icon: 'git-merge', text: `Merging${suffix}` };
    case 'rebase':
      return {
        icon: state.editStop ? 'debug-pause' : 'git-pull-request',
        text: `${state.editStop ? 'Editing' : 'Rebasing'}${progress}${suffix}`,
      };
    case 'cherry-pick':
      return { icon: 'git-commit', text: `Cherry-picking${suffix}` };
    case 'revert':
      return { icon: 'discard', text: `Reverting${suffix}` };
    case 'am':
      return { icon: 'mail', text: `Applying patches${progress}` };
    case 'bisect':
      return state.bisect?.firstBad
        ? { icon: 'pass-filled', text: `Found ${short(state.bisect.firstBad)}` }
        : { icon: 'search', text: `Bisecting · ${state.bisect?.remaining ?? 0} left` };
    default:
      return { icon: 'warning', text: 'Operation in progress' };
  }
}

/**
 * The status bar item: the branch and how it stands against its upstream (click: switch
 * branches), or, while git is stopped in the middle of an operation, what it is doing (click:
 * the Lanefold panel, where the banner offers the next steps).
 */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'lanefold.status',
    vscode.StatusBarAlignment.Left,
    // Right after VS Code's own source control items.
    99,
  );
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;

  constructor(private readonly registry: RepositoryRegistry) {
    this.item.name = 'Lanefold';
    this.disposables.push(
      this.item,
      toDisposable(registry.onDidChangeRepos(() => this.schedule(0))),
      toDisposable(
        registry.onDidChangeRepo(({ repo, kinds }) => {
          if (repo !== registry.active) return;
          // `config`: an upstream set or unset (push -u, branch --unset-upstream).
          if (REFRESH_ON.some((kind) => kinds.has(kind))) this.schedule(150);
        }),
      ),
    );
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), delayMs);
  }

  private async update(): Promise<void> {
    const version = ++this.version;
    const repo = this.registry.active;
    if (!repo) {
      this.item.hide();
      return;
    }
    let status: Awaited<ReturnType<typeof headStatus>>;
    let state: OpState;
    try {
      [status, state] = await Promise.all([headStatus(repo), readOpState(repo)]);
    } catch {
      this.item.hide();
      return;
    }
    if (version !== this.version) return;
    const repoLine = this.registry.all.length > 1 ? `${repo.name}: ` : '';
    if (state.kind) {
      const { icon, text } = describe(state);
      this.item.text = `$(${icon}) ${text}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.command = { command: 'lanefold.open', title: 'Open Lanefold' };
      this.item.tooltip = new vscode.MarkdownString(
        `**${repoLine}${text}**${state.commitSubject ? `\n\n“${state.commitSubject}”` : ''}\n\nClick to open Lanefold, where you can continue, skip or abort.`,
      );
    } else {
      const name = status.branch ?? (status.sha ? short(status.sha) : 'no commits yet');
      const counts = `${status.ahead > 0 ? ` ↑${status.ahead}` : ''}${status.behind > 0 ? ` ↓${status.behind}` : ''}`;
      this.item.text = `$(${status.branch ? 'git-branch' : 'git-commit'}) ${name}${counts}`;
      this.item.backgroundColor = undefined;
      this.item.command = { command: 'lanefold.switchBranch', title: 'Switch Branch' };
      const sync = status.upstream
        ? status.ahead + status.behind === 0
          ? `In sync with ${status.upstream} (as of the last fetch).`
          : [
              status.ahead > 0 ? `${status.ahead} commit${status.ahead === 1 ? '' : 's'} to push` : '',
              status.behind > 0 ? `${status.behind} to pull` : '',
            ]
              .filter(Boolean)
              .join(', ') + ` (${status.upstream}, as of the last fetch).`
        : status.branch
          ? 'Not published yet (no upstream).'
          : 'Detached HEAD: not on a branch.';
      this.item.tooltip = new vscode.MarkdownString(
        `**${repoLine}${name}**\n\n${sync}\n\nClick to switch branches.`,
      );
    }
    this.item.show();
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function toDisposable(disposable: { dispose(): void }): vscode.Disposable {
  return new vscode.Disposable(() => disposable.dispose());
}
