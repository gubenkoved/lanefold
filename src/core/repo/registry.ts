import type { RepoChangeKind } from '../../shared/models';
import { Emitter, type Disposable } from '../util/emitter';
import type { Repository } from './repository';

export interface RepoChangeEvent {
  readonly repo: Repository;
  readonly kinds: ReadonlySet<RepoChangeKind>;
}

/** The set of open repositories plus which one the UI is focused on. */
export class RepositoryRegistry implements Disposable {
  private readonly repos = new Map<string, Repository>();
  private activeId: string | undefined;

  private readonly onDidChangeReposEmitter = new Emitter<void>();
  private readonly onDidChangeRepoEmitter = new Emitter<RepoChangeEvent>();

  /** Fires when repositories are added/removed or the active repository changes. */
  readonly onDidChangeRepos = this.onDidChangeReposEmitter.event;
  /** Fires (debounced by the watcher) when something inside a repository changed. */
  readonly onDidChangeRepo = this.onDidChangeRepoEmitter.event;

  constructor(private readonly preferredActiveId?: string) {}

  get all(): readonly Repository[] {
    return [...this.repos.values()].sort((a, b) => a.root.localeCompare(b.root));
  }

  get active(): Repository | undefined {
    return this.activeId === undefined ? undefined : this.repos.get(this.activeId);
  }

  get(id: string): Repository | undefined {
    return this.repos.get(id);
  }

  add(repo: Repository): boolean {
    if (this.repos.has(repo.id)) return false;
    this.repos.set(repo.id, repo);
    if (this.activeId === undefined || repo.id === this.preferredActiveId) this.activeId = repo.id;
    this.onDidChangeReposEmitter.fire();
    return true;
  }

  remove(id: string): void {
    if (!this.repos.delete(id)) return;
    if (this.activeId === id) this.activeId = this.all[0]?.id;
    this.onDidChangeReposEmitter.fire();
  }

  setActive(id: string): void {
    if (!this.repos.has(id) || this.activeId === id) return;
    this.activeId = id;
    this.onDidChangeReposEmitter.fire();
  }

  notifyChange(id: string, kinds: Iterable<RepoChangeKind>): void {
    const repo = this.repos.get(id);
    const set = new Set(kinds);
    if (repo && set.size > 0) this.onDidChangeRepoEmitter.fire({ repo, kinds: set });
  }

  dispose(): void {
    this.onDidChangeReposEmitter.dispose();
    this.onDidChangeRepoEmitter.dispose();
    this.repos.clear();
  }
}
