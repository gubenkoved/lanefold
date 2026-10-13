import { useHost } from '../hostContext';
import { redo, runOperation, undo, useOperations } from '../state/operations';
import { useQuery, useRepoVersion } from '../state/queries';
import { addRemote, useRemotes } from '../state/remotes';
import { useEditorShowing } from '../state/rewrite';
import { REFRESH_EVENT, showStashes, useApp } from '../state/store';
import { remotesMenuEntries } from '../views/log/remoteMenu';
import { showSubmodulesList } from '../views/log/submodules';
import { Icon } from './Icon';
import { IconButton } from './IconButton';
import { openMenu, type MenuEntry } from './Menu';
import { TabStrip } from './TabStrip';
import styles from './TopBar.module.css';

function RepoChip() {
  const host = useHost();
  const repos = useApp((state) => state.repos);
  const activeRepoId = useApp((state) => state.activeRepoId);
  const head = useApp((state) => (state.activeRepoId ? state.heads[state.activeRepoId] : undefined));
  const remotes = useRemotes(activeRepoId);
  const repo = repos.find((r) => r.id === activeRepoId);
  if (!repo) return null;

  const branchLabel = head
    ? head.detached
      ? (head.sha?.slice(0, 7) ?? 'detached')
      : head.branch
    : undefined;

  const showMenu = async (anchor: Element) => {
    const [known, submodules] = await Promise.all([
      // Opened as the view loads, before the remotes are known: they are asked for first.
      remotes ?? host.rpc.call('repo.remotes', { repoId: repo.id }).catch(() => []),
      // The submodules, with their actions: also where the branches pane does not fit.
      host.rpc.call('submodule.list', { repoId: repo.id }).catch(() => []),
    ]);
    const entries: MenuEntry[] = [
      { kind: 'header', label: 'Repositories' },
      ...repos.map((r): MenuEntry => ({
        id: r.id,
        label: r.name,
        hint: r.root,
        checked: r.id === activeRepoId,
        onSelect: () => useApp.getState().selectRepo(r.id),
      })),
    ];
    entries.push(
      { kind: 'separator' },
      {
        id: 'apply-patch',
        label: 'Apply a patch file…',
        icon: 'diff',
        hint: 'git apply / git am',
        onSelect: () =>
          void host.rpc
            .call('host.pickFile', { repoId: repo.id, title: 'Apply a patch file' })
            .then((file) => file && void runOperation({ kind: 'applyPatch', file })),
      },
      submodules.length > 0
        ? {
            id: 'submodules',
            label: `Submodules (${submodules.length})…`,
            icon: 'file-submodule',
            onSelect: () => showSubmodulesList(repo.id, submodules, anchor),
          }
        : {
            id: 'add-submodule',
            label: 'Add a submodule…',
            icon: 'file-submodule',
            hint: 'git submodule add',
            onSelect: () => void runOperation({ kind: 'addSubmodule', url: '', path: '' }),
          },
      // Here too, for narrow views (where the branches pane steps aside).
      { kind: 'separator' },
      { kind: 'header', label: 'Remotes' },
      ...remotesMenuEntries(known),
    );
    if (host.kind !== 'harness') {
      entries.push(
        { kind: 'separator' },
        {
          id: 'settings',
          label: 'Lanefold Settings',
          icon: 'settings-gear',
          onSelect: () => void host.rpc.call('host.command', { command: 'openSettings' }),
        },
      );
    }
    openMenu(anchor, entries);
  };

  return (
    <button
      type="button"
      className={styles.repo}
      onClick={(event) => void showMenu(event.currentTarget)}
      title={repo.root}
    >
      <Icon name="repo" />
      <span className={styles.repoName}>{repo.name}</span>
      {branchLabel ? (
        <span className={styles.branch}>
          <Icon name={head?.detached ? 'git-commit' : 'git-branch'} />
          {branchLabel}
        </span>
      ) : null}
      <Icon name="chevron-down" className={styles.chevron} />
    </button>
  );
}

function UndoButtons() {
  const info = useOperations((state) => state.undo);
  // The history editor has an Undo of its own (for the arrangement): while it shows, git's
  // waits, so that no operation is undone underneath an edit by mistake.
  const editing = useEditorShowing();
  const paused = editing ? ' (paused while you edit history)' : '';
  return (
    <>
      <IconButton
        icon="reply"
        label={info.undo ? `Undo: ${info.undo}${paused}` : 'Nothing to undo'}
        disabled={!info.undo || editing}
        onClick={() => void undo()}
      />
      <IconButton
        icon="redo"
        label={info.redo ? `Redo: ${info.redo}${paused}` : 'Nothing to redo'}
        disabled={!info.redo || editing}
        onClick={() => void redo()}
      />
    </>
  );
}

/**
 * Fetch, pull (with the incoming count) and push (with the outgoing count) for the current branch;
 * without a remote to sync with, the way to add one.
 */
function SyncButtons() {
  const host = useHost();
  const repoId = useApp((state) => state.activeRepoId);
  const version = useRepoVersion(host.rpc, repoId ?? '');
  const refs = useQuery(repoId ? `${repoId}:${version}` : undefined, () =>
    host.rpc.call('repo.refs', { repoId: repoId! }),
  );
  const remotes = useRemotes(repoId);
  const running = useOperations((state) => state.running);
  const snapshot = refs.data;
  if (!snapshot || !remotes) return null;
  if (remotes.length === 0)
    return (
      <button
        type="button"
        className={styles.addRemote}
        title="Add a remote: a repository to fetch from and push to"
        aria-label="Add remote…"
        disabled={!!running}
        onClick={() => addRemote(remotes)}
      >
        <Icon name="cloud" />
        <span className={styles.addRemoteLabel}>Add remote…</span>
      </button>
    );
  const name = snapshot.head.branch;
  const branch = name ? snapshot.refs.find((ref) => ref.kind === 'branch' && ref.short === name) : undefined;
  const ahead = branch?.ahead ?? 0;
  const behind = branch?.behind ?? 0;
  const upstream = branch?.upstream;
  const busy = (kind: string) => running === kind;

  return (
    <div className={styles.sync} role="group" aria-label="Sync">
      <button
        type="button"
        className={styles.syncButton}
        title="Fetch: download what is new on the remotes (your branches do not change)"
        aria-label="Fetch"
        disabled={!!running}
        onClick={() => void runOperation({ kind: 'fetch' })}
      >
        <Icon name={busy('fetch') ? 'loading' : 'repo-fetch'} spin={busy('fetch')} />
      </button>
      <button
        type="button"
        className={styles.syncButton}
        title={
          !upstream
            ? 'Pull: this branch has no upstream yet'
            : behind > 0
              ? `Pull ${behind} commit${behind === 1 ? '' : 's'} from ${upstream} (as of the last fetch)`
              : `Pull from ${upstream}`
        }
        aria-label="Pull"
        disabled={!upstream || !!running}
        onClick={() =>
          void (ahead > 0
            ? runOperation({ kind: 'pull', mode: 'rebase' }, { review: true })
            : runOperation({ kind: 'pull', mode: 'ff-only' }))
        }
      >
        <Icon name={busy('pull') ? 'loading' : 'arrow-down'} spin={busy('pull')} />
        {behind > 0 ? <span className={styles.count}>{behind}</span> : null}
      </button>
      <button
        type="button"
        className={styles.syncButton}
        title={
          !name
            ? 'Push: check out a branch first'
            : !upstream
              ? `Publish ${name} to the remote`
              : ahead > 0
                ? `Push ${ahead} commit${ahead === 1 ? '' : 's'} to ${upstream}`
                : `Push to ${upstream}`
        }
        aria-label={upstream ? 'Push' : 'Publish branch'}
        disabled={!name || !!running}
        onClick={() => void runOperation({ kind: 'push' })}
      >
        <Icon name={busy('push') ? 'loading' : upstream ? 'arrow-up' : 'cloud-upload'} spin={busy('push')} />
        {ahead > 0 ? <span className={styles.count}>{ahead}</span> : null}
      </button>
    </div>
  );
}

/** The number of stashes, when there are any; opens the stash list. */
function StashButton() {
  const host = useHost();
  const repoId = useApp((state) => state.activeRepoId);
  const version = useRepoVersion(host.rpc, repoId ?? '', ['stash']);
  const list = useQuery(repoId ? `${repoId}:stashes:${version}` : undefined, () =>
    host.rpc.call('stash.list', { repoId: repoId! }),
  );
  const count = list.data?.length ?? 0;
  if (count === 0) return null;
  return (
    <button
      type="button"
      className={styles.stash}
      title="Show the stash list"
      aria-label={`Stashes (${count})`}
      onClick={showStashes}
    >
      <Icon name="git-stash" />
      {count} {count === 1 ? 'stash' : 'stashes'}
    </button>
  );
}

export function TopBar() {
  const host = useHost();
  return (
    <header className={styles.bar}>
      <RepoChip />
      <div className={styles.divider} />
      <div className={styles.tabs}>
        <TabStrip />
      </div>
      <div className={styles.actions}>
        <StashButton />
        <SyncButtons />
        <UndoButtons />
        <IconButton
          icon="refresh"
          label="Refresh"
          onClick={() => window.dispatchEvent(new CustomEvent(REFRESH_EVENT))}
        />
        {host.kind === 'panel' ? (
          <IconButton
            icon="link-external"
            label="Open in Editor Tab"
            onClick={() => void host.rpc.call('host.command', { command: 'openInEditor' })}
          />
        ) : null}
      </div>
    </header>
  );
}
