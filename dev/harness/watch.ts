import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { classifyGitDirChange } from '../../src/core/repo/changes';
import type { Repository } from '../../src/core/repo/repository';
import { debounceCollect, type Disposable } from '../../src/core/util/emitter';
import type { RepoChangeKind } from '../../src/shared/models';

/** Node fs.watch-based equivalent of the extension's VS Code file watcher. */
export function watchRepositoryFs(
  repo: Repository,
  onChange: (kinds: ReadonlySet<RepoChangeKind>) => void,
): Disposable {
  const watchers: FSWatcher[] = [];
  const gitChanges = debounceCollect<RepoChangeKind>(100, onChange);
  const worktreeChanges = debounceCollect<RepoChangeKind>(400, onChange);

  // A watched directory that disappears (a test repository deleted) must not take the harness down.
  const keep = (watcher: FSWatcher) => {
    watcher.on('error', () => watcher.close());
    watchers.push(watcher);
  };

  const watchGitDir = (base: string) => {
    try {
      // The git dir itself: rebase-merge/, sequencer/ and the like show up here as they come and go.
      keep(
        watch(base, (_event, file) => {
          const kind = file ? classifyGitDirChange(String(file)) : undefined;
          if (kind) gitChanges(kind);
        }),
      );
    } catch (error) {
      console.warn(`[harness] cannot watch ${base}: ${String(error)}`);
    }
    // The stash list is the stash's reflog: dropping an older entry changes only that file.
    // (No refs/ in a linked worktree's own git dir: the common dir has it.)
    for (const dir of ['refs', 'logs/refs'])
      watchTree(resolve(base, dir), keep, (path) => {
        const kind = classifyGitDirChange(`${dir}/${path}`);
        if (kind) gitChanges(kind);
      });
  };
  watchGitDir(repo.gitDir);
  if (resolve(repo.commonDir) !== resolve(repo.gitDir)) watchGitDir(repo.commonDir);
  // A commit or checkout inside a submodule moves its HEAD under modules/: what this
  // repository's status says about the submodule changes, though its files may not.
  watchTree(
    resolve(repo.commonDir, 'modules'),
    keep,
    (path) => {
      const kind = classifyGitDirChange(`modules/${path}`);
      if (kind) worktreeChanges(kind);
    },
    // A submodule's objects: thousands of folders, none of them telling anything new.
    (path, full) => /(?:^|\/)objects$/.test(path) && existsSync(join(full, '..', 'HEAD')),
  );

  // The working tree, git dirs left out (every folder of .git/objects would be watched), and
  // what VS Code leaves out by default too (node_modules), since inotify watches are a per-user
  // budget shared with every editor (and every other harness) on the machine.
  const gitDir = relative(repo.root, repo.gitDir).split(sep).join('/');
  watchTree(
    repo.root,
    keep,
    () => worktreeChanges('worktree'),
    (path) =>
      path === gitDir || path.startsWith(`${gitDir}/`) || /(?:^|\/)(?:\.git|node_modules)$/.test(path),
  );

  return {
    dispose: () => {
      for (const watcher of watchers) watcher.close();
      gitChanges.dispose();
      worktreeChanges.dispose();
    },
  };
}

let outOfWatches = false;

/** Says once that the machine's file watches ran out: changes go unseen until some are freed. */
function warnOutOfWatches(): void {
  if (outOfWatches) return;
  outOfWatches = true;
  console.warn(
    '[harness] out of file watches (inotify): changes will go unseen. Close programs that watch many files, or raise fs.inotify.max_user_watches.',
  );
}

/**
 * Watches `root` and every folder in it, each folder with a plain (non-recursive) fs.watch, all
 * set up before this returns: Node's recursive watching on Linux sets up the folders inside
 * asynchronously, and a change made right after it started went unseen (a test editing a file
 * as soon as the view showed was flaky). Folders made later are watched as they appear.
 * `onEvent` gets each changed path relative to `root` (forward slashes); `skip` leaves folders
 * out, with what is in them. Nothing happens if `root` does not exist.
 */
function watchTree(
  root: string,
  keep: (watcher: FSWatcher) => void,
  onEvent: (path: string) => void,
  skip: (path: string, full: string) => boolean = () => false,
): void {
  const watched = new Map<string, FSWatcher>();
  const isFolder = (full: string) => {
    try {
      return statSync(full).isDirectory();
    } catch {
      return false;
    }
  };
  const add = (dir: string) => {
    let watcher: FSWatcher;
    try {
      watcher = watch(dir, (event, file) => {
        if (!file) return;
        const full = join(dir, String(file));
        const path = relative(root, full).split(sep).join('/');
        if (skip(path, full)) return;
        onEvent(path);
        // A folder made (or deleted and made again): watched from now on, with what is in it.
        if (event === 'rename' && isFolder(full)) {
          // (A watcher closes a tick later: out of the map first, so its folder is watched again.)
          const old = watched.get(full);
          watched.delete(full);
          old?.close();
          addTree(full);
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') warnOutOfWatches();
      return; // Gone already.
    }
    watcher.on('close', () => {
      if (watched.get(dir) === watcher) watched.delete(dir);
    });
    keep(watcher);
    watched.set(dir, watcher);
  };
  const addTree = (dir: string) => {
    if (!watched.has(dir)) add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (!skip(relative(root, full).split(sep).join('/'), full)) addTree(full);
    }
  };
  if (isFolder(root)) addTree(root);
}
