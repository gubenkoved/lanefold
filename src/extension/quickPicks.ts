import * as vscode from 'vscode';
import { branchChoices, recentBranches, type BranchChoice } from '../core/repo/branchChoices';
import type { Repository } from '../core/repo/repository';

interface BranchItem extends vscode.QuickPickItem {
  readonly choice?: BranchChoice;
  readonly action?: 'create' | 'detach';
}

function age(seconds: number): string {
  const days = Math.floor((Date.now() / 1000 - seconds) / 86400);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function item(choice: BranchChoice): BranchItem {
  const counts = [
    choice.ahead ? `↑${choice.ahead}` : '',
    choice.behind ? `↓${choice.behind}` : '',
    choice.gone ? 'upstream gone' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    label: `$(${choice.kind === 'remote' ? 'cloud' : choice.current ? 'check' : 'git-branch'}) ${choice.name}`,
    description: [counts, choice.current ? 'checked out' : ''].filter(Boolean).join(' · '),
    detail: `${choice.subject} · ${age(choice.time)}`,
    choice,
  };
}

/**
 * Picks a branch to switch to: recently used first, then local branches by latest commit, then
 * remote branches that have no local branch yet. Resolves the branch name, "create" for a new
 * branch, or undefined if dismissed.
 */
export async function pickBranchToSwitch(repo: Repository): Promise<string | 'create' | undefined> {
  const [choices, recent] = await Promise.all([branchChoices(repo), recentBranches(repo)]);
  const local = choices.filter((choice) => choice.kind === 'branch');
  const localNames = new Set(local.map((choice) => choice.name));
  const recentChoices = recent
    .map((name) => local.find((choice) => choice.name === name))
    .filter((choice): choice is BranchChoice => !!choice);
  const rest = local.filter((choice) => !recent.includes(choice.name));
  // A remote branch already checked out locally is reached through the local one.
  const remotes = choices.filter(
    (choice) => choice.kind === 'remote' && !localNames.has(choice.name.slice(choice.name.indexOf('/') + 1)),
  );
  const items: BranchItem[] = [
    { label: '$(add) Create new branch…', description: 'from the current commit', action: 'create' },
  ];
  const section = (label: string, list: readonly BranchChoice[]) => {
    if (list.length === 0) return;
    items.push({ label, kind: vscode.QuickPickItemKind.Separator }, ...list.map(item));
  };
  section('Recent', recentChoices);
  section('Branches', rest);
  section('Remote branches', remotes);
  const picked = await vscode.window.showQuickPick(items, {
    title: `Switch branch — ${repo.name}`,
    placeHolder: 'Type to find a branch',
    matchOnDetail: true,
  });
  if (!picked) return undefined;
  if (picked.action === 'create') return 'create';
  return picked.choice?.name;
}

/** Picks two revisions to compare (the current branch is offered first). */
export async function pickComparison(repo: Repository): Promise<{ a: string; b: string } | undefined> {
  const choices = await branchChoices(repo);
  const current = choices.find((choice) => choice.current);
  const pick = async (title: string, exclude?: string) => {
    const quickPick = vscode.window.createQuickPick<BranchItem>();
    quickPick.title = title;
    quickPick.placeholder = 'A branch, or type any revision (a tag, a commit hash, HEAD~3) and press Enter';
    quickPick.matchOnDetail = true;
    // The checked-out branch first: comparing with it is the usual case.
    const offered = choices.filter((choice) => choice.name !== exclude);
    quickPick.items = [
      ...offered.filter((choice) => choice === current),
      ...offered.filter((choice) => choice !== current),
    ].map(item);
    return new Promise<string | undefined>((resolve) => {
      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0]?.choice?.name ?? quickPick.value.trim();
        resolve(selected || undefined);
        quickPick.hide();
      });
      quickPick.onDidHide(() => {
        resolve(undefined);
        quickPick.dispose();
      });
      quickPick.show();
    });
  };
  const a = await pick(`Compare (1/2): the base — ${repo.name}`);
  if (!a) return undefined;
  const b = await pick(`Compare ${a} with… (2/2)`, a);
  return b ? { a, b } : undefined;
}
