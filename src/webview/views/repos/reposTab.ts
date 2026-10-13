import type { RepoSummary } from '../../../shared/models';
import { objectStores, storeKey } from '../../../shared/repoGroups';
import { assignColorSlots } from '../../graph/repoColorSlots';
import { showInLog, useApp, type AppStore } from '../../state/store';

export const REPOS_ICON = 'folder-library';
export const REPOS_TITLE = 'All repositories';

/** One repository of the "All repositories" view: an object store, with its open worktrees. */
export interface RepoStore {
  /** Its first open worktree, which its rows, details and "Show in" use. */
  readonly id: string;
  readonly name: string;
  /** Its open worktrees, that one first. */
  readonly members: readonly RepoSummary[];
  /** Its color slot (see `assignColorSlots`): its own, kept while others come and go. */
  readonly colorIndex: number;
}

/** The color slots given to the open repositories (by git directory), for as long as they stay open. */
const colorSlots = new Map<string, number>();

/** The parent folder's name ("work" for /home/me/work/app). */
function parentName(root: string): string {
  const parts = root.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 2] ?? root;
}

/**
 * The open repositories, one per object store (linked worktrees share theirs), in the order of
 * the repository picker. Folder names that are not unique get their parent folder's name.
 */
export function repoStores(repos: readonly RepoSummary[]): RepoStore[] {
  const groups = objectStores(repos);
  const counts = new Map<string, number>();
  for (const [first] of groups) counts.set(first!.name, (counts.get(first!.name) ?? 0) + 1);
  // Colors follow each repository's git directory, not its place in the list.
  const slots = assignColorSlots(
    groups.map(([first]) => storeKey(first!.commonDir)),
    colorSlots,
  );
  return groups.map((members, index) => {
    const first = members[0]!;
    const name = counts.get(first.name)! > 1 ? `${first.name} (${parentName(first.root)})` : first.name;
    return { id: first.id, name, members, colorIndex: slots[index]! };
  });
}

/** Opens the "All repositories" tab: the one this repository's tabs have, or a new one. */
export function openReposTab(): void {
  const { tabs, activateTab, addTab } = useApp.getState();
  const existing = tabs.tabs.find((tab) => tab.kind === 'repos');
  if (existing) activateTab(existing.id);
  else addTab({ kind: 'repos', title: REPOS_TITLE, view: { scope: { type: 'all' } } });
}

/**
 * Makes `repoId` the active repository, then runs `action` once its own tabs are loaded (a
 * repository's views open among its tabs). Given up if it does not become active (it closed).
 */
export function inRepository(repoId: string, action: () => void): void {
  const ready = (state: AppStore) => state.activeRepoId === repoId && state.tabsRepoId === repoId;
  if (ready(useApp.getState())) {
    action();
    return;
  }
  const unsubscribe = useApp.subscribe((state) => {
    if (!ready(state)) return;
    clearTimeout(timer);
    unsubscribe();
    action();
  });
  const timer = setTimeout(unsubscribe, 15_000);
  useApp.getState().selectRepo(repoId);
}

/** "Show in <repository>": switches to the repository and selects the commit in its own log. */
export function showInRepository(repoId: string, sha: string): void {
  inRepository(repoId, () => showInLog(repoId, sha));
}
