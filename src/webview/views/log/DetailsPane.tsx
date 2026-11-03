import { useMemo, useState, type MouseEvent } from 'react';
import type { ChangedFile, CommitDetails, CommitMeta, CompareSummary } from '../../../shared/models';
import { errorText } from '../../bridge/errorText';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { IconButton } from '../../components/IconButton';
import { openMenu, type MenuEntry } from '../../components/Menu';
import { toast } from '../../components/Toast';
import { absoluteTime, isWorkingTreeSha, relativeLong, shortSha } from '../../graph/format';
import type { LogModel } from '../../graph/logModel';
import { useHost } from '../../hostContext';
import { changeIndex } from '../../state/indexChanges';
import { runOperation } from '../../state/operations';
import { fetchCommitDetails, useQuery, useRepoVersion } from '../../state/queries';
import { showStashes } from '../../state/store';
import { openStats, STATS_ICON } from '../stats/statsTab';
import { CommitBox } from './CommitBox';
import { ContainedIn } from './ContainedIn';
import { openAllDiffs, openFileDiff, sideLabel } from './diffActions';
import { FileAction, FileList, totals, TreeToggle } from './FileList';
import { commitFileEntries, fileMenu, type FileMenuScope } from './fileMenus';
import { useInlineDiffs } from './InlineDiff';
import {
  ActionButton,
  Avatar,
  CommitChip,
  ErrorLine,
  LoadingLine,
  Notice,
  RefPills,
  Section,
  ShaChip,
  useModelVersion,
} from './parts';
import { SubmoduleFileActions } from './submodules';
import styles from './DetailsPane.module.css';

export interface DetailsPaneProps {
  readonly repoId: string;
  readonly model: LogModel;
  /** Selected commits in row order (newest first). */
  readonly selection: readonly string[];
  /** Selects a commit in the graph and scrolls to it. */
  readonly onReveal: (sha: string) => void;
  /** Highlights commits in the graph (undefined clears). */
  readonly onHighlight: (shas: readonly string[] | undefined) => void;
  readonly onOpenCompare: (a: string, b: string) => void;
  /** The log of several repositories: offer nothing that changes `repoId` (see FileMenuScope). */
  readonly scope?: FileMenuScope;
  /** The pane is a single line (stacked under the graph with nothing selected). */
  readonly compact?: boolean;
}

/** The right-hand pane: adapts to what is selected (one commit, two, several, uncommitted). */
export function DetailsPane(props: DetailsPaneProps) {
  useModelVersion(props.model);
  const { selection } = props;
  const workingTree = selection.length === 1 && isWorkingTreeSha(selection[0]!);
  let content;
  if (selection.length === 0) content = <SelectionHint model={props.model} compact={props.compact} />;
  else if (selection.length === 1)
    content = workingTree ? (
      <WorkingTreeDetails {...props} />
    ) : (
      <CommitDetailsView {...props} sha={selection[0]!} />
    );
  else if (selection.length === 2)
    // Keyed by the pair: swapping sides is a choice for that pair only.
    content = (
      <CompareDetails
        key={`${selection[1]}:${selection[0]}`}
        {...props}
        from={selection[1]!}
        to={selection[0]!}
      />
    );
  else content = <CumulativeDetails {...props} />;
  return (
    // Uncommitted changes adapt to the pane's height (see .workingTree).
    <div className={styles.root} data-worktree={workingTree || undefined}>
      {content}
    </div>
  );
}

/** What the pane says with nothing selected: how to select, and what dragging does. */
function SelectionHint({ model, compact }: { model: LogModel; compact?: boolean }) {
  // A repository without commits: its first commit is what there is to make.
  const fresh = model.refs.head.unborn && model.refs.refs.length === 0;
  if (compact)
    return (
      <div className={styles.hintLine}>
        <Icon name={fresh ? 'git-commit' : 'info'} />
        <span>
          {fresh
            ? 'No commits yet — stage files and make the first commit.'
            : 'Select a commit to see its changes.'}
        </span>
      </div>
    );
  if (fresh)
    return (
      <div className={styles.hint}>
        <EmptyState
          compact
          title="No commits yet"
          description={
            model.hasWorkingTreeRow ? (
              <>
                Select <strong>Uncommitted changes</strong>, stage files and make the first commit.
              </>
            ) : (
              'Add files, stage them and make the first commit.'
            )
          }
        />
      </div>
    );
  return (
    <div className={styles.hint}>
      <EmptyState
        compact
        title="Nothing selected"
        description={
          <>
            Select a commit to see its changes.
            <br />
            Select <strong>two</strong> to compare them, or <strong>several</strong> to see their combined
            changes.
          </>
        }
      />
      <dl className={styles.keys}>
        <dt>Click · ↑↓</dt>
        <dd>Select a commit</dd>
        <dt>Ctrl+Click</dt>
        <dd>Add to the selection</dd>
        <dt>Shift+Click · drag</dt>
        <dd>Select a range</dd>
        <dt>← →</dt>
        <dd>Go to child / parent</dd>
        <dt>Enter</dt>
        <dd>Open all changes</dd>
        <dt>Drag a branch pill</dt>
        <dd>Move, merge or rebase it</dd>
        <dt>Drag selected commits</dt>
        <dd>Squash them or cherry-pick them</dd>
        <dt>Drag Uncommitted changes</dt>
        <dd>Amend a commit with them</dd>
      </dl>
    </div>
  );
}

// ---- one commit -----------------------------------------------------------------------------

/** In a file, folder or line history view: whether a changed file is (in) what the view follows. */
function followed(model: LogModel): ((file: ChangedFile) => boolean) | undefined {
  const view = model.view;
  const paths = view.lines ? [view.lines.path] : (view.paths ?? []);
  if (paths.length === 0) return undefined;
  return (file) =>
    paths.some(
      (path) =>
        file.path === path || file.oldPath === path || file.path.startsWith(`${path.replace(/\/$/, '')}/`),
    );
}

function Identity({
  meta,
  verb,
  stats,
}: {
  meta: CommitMeta;
  verb: 'authored' | 'committed';
  /** Offers the person's statistics (in the repository's own log). */
  stats?: boolean;
}) {
  const name = verb === 'authored' ? meta.author : meta.committer;
  const email = verb === 'authored' ? meta.authorEmail : meta.committerEmail;
  const time = verb === 'authored' ? meta.authorTime : meta.committerTime;
  return (
    <div className={styles.identity}>
      <Avatar name={name} email={email} size={verb === 'authored' ? 26 : 18} />
      <div className={styles.identityText}>
        <span className={styles.person}>
          <strong>{name}</strong> <span className={styles.email}>{email}</span>
        </span>
        <span className={styles.when} title={absoluteTime(time)}>
          {verb} {relativeLong(time)}
        </span>
      </div>
      {stats ? (
        <IconButton
          icon={STATS_ICON}
          label={`Statistics for ${name || email}`}
          small
          onClick={() => openStats({ author: name.trim() || `<${email}>` })}
        />
      ) : null}
    </div>
  );
}

function CommitHeader({
  repoId,
  meta,
  model,
  onReveal,
  stats,
}: {
  repoId: string;
  meta: CommitMeta;
  model: LogModel;
  onReveal: (sha: string) => void;
  /** Offers the author's statistics. */
  stats?: boolean;
}) {
  const refs = model.refsAt(model.rowOf(meta.sha)) ?? [];
  const committedSeparately =
    meta.committer !== meta.author ||
    meta.committerEmail !== meta.authorEmail ||
    Math.abs(meta.committerTime - meta.authorTime) > 60;
  return (
    <header className={styles.header}>
      <h2 className={styles.subject}>{meta.subject || <em>(no message)</em>}</h2>
      <Identity meta={meta} verb="authored" stats={stats} />
      {committedSeparately ? <Identity meta={meta} verb="committed" /> : null}
      <div className={styles.chips}>
        <ShaChip sha={meta.sha} />
        {meta.parents.map((parent, index) => (
          <span key={parent} className={styles.parent}>
            <span className={styles.parentLabel}>
              {meta.parents.length > 1 ? `parent ${index + 1}` : 'parent'}
            </span>
            <button
              type="button"
              className={styles.link}
              onClick={() => onReveal(parent)}
              title="Go to parent"
            >
              {shortSha(parent)}
            </button>
          </span>
        ))}
        {meta.signed ? (
          <span className={styles.signed} title="This commit carries a signature">
            <Icon name="workspace-trusted" /> signed
          </span>
        ) : null}
      </div>
      {refs.length > 0 ? <RefPills refs={refs} /> : null}
      <ContainedIn repoId={repoId} model={model} sha={meta.sha} onReveal={onReveal} />
    </header>
  );
}

function CommitDetailsView({ repoId, model, sha, onReveal, scope }: DetailsPaneProps & { sha: string }) {
  const host = useHost();
  const details = useQuery<CommitDetails>(`${repoId}:${sha}`, () =>
    fetchCommitDetails(host.rpc, repoId, sha),
  );
  const current = details.data?.sha === sha ? details.data : undefined;
  const meta = current ?? model.metaOf(sha);
  if (!meta) return details.error ? <ErrorLine error={details.error} /> : <LoadingLine />;
  const base = current?.diffBase;
  const files = current?.files ?? [];
  const stats = totals(files);
  const isMerge = meta.parents.length > 1;
  return (
    <div className={styles.scroll}>
      <CommitHeader repoId={repoId} meta={meta} model={model} onReveal={onReveal} stats={!scope} />
      {current?.body ? <pre className={styles.body}>{current.body}</pre> : null}
      {isMerge ? (
        <Notice icon="git-merge">
          Merge commit — changes are shown against the first parent ({shortSha(meta.parents[0]!)}).
        </Notice>
      ) : null}
      <Section
        title="Changes"
        count={current ? files.length : undefined}
        stats={current ? stats : undefined}
        actions={
          <>
            <TreeToggle />
            <ActionButton
              icon="diff-multiple"
              label="Open all"
              title="Open all changes in a multi-file diff"
              disabled={files.length === 0}
              onClick={() =>
                openAllDiffs(host.rpc, repoId, `${shortSha(sha)} ${meta.subject}`, files, base, sha)
              }
            />
          </>
        }
      >
        {current ? (
          <FileList
            files={files}
            emptyText="This commit changes no files."
            emphasize={followed(model)}
            onOpen={(file) => openFileDiff(host.rpc, repoId, file, base, sha)}
            onContextMenu={(file, event) =>
              fileMenu(
                file,
                event,
                () => openFileDiff(host.rpc, repoId, file, base, sha),
                commitFileEntries(repoId, file, sha, base, scope),
                scope,
              )
            }
          />
        ) : details.error ? (
          <ErrorLine error={details.error} />
        ) : (
          <LoadingLine text="Loading changes…" />
        )}
      </Section>
    </div>
  );
}

// ---- uncommitted changes --------------------------------------------------------------------

type GroupKind = 'conflicts' | 'staged' | 'changes' | 'untracked';

function WorkingTreeDetails({ repoId, model }: DetailsPaneProps) {
  const host = useHost();
  const tree = model.workingTree;
  // Re-query whenever the counts change (the log refreshes them on every edit), and when lines
  // are staged (the counts may stay the same).
  const filesVersion = useRepoVersion(host.rpc, repoId, ['index', 'worktree']);
  const key = `${repoId}:${model.id}:${JSON.stringify(tree)}:${filesVersion}`;
  const changes = useQuery(key, () => host.rpc.call('repo.worktreeChanges', { repoId }));
  const inlineDiffs = useInlineDiffs(repoId);
  const stashVersion = useRepoVersion(host.rpc, repoId, ['stash']);
  const stashes = useQuery(`${repoId}:stashes:${stashVersion}`, () =>
    host.rpc.call('stash.list', { repoId }),
  );
  const stashCount = stashes.data?.length ?? 0;
  const data = changes.data;
  const head = model.refs.head;
  const headRev = head.unborn ? undefined : 'HEAD';

  const call = (method: 'index.stage' | 'index.unstage' | 'conflict.markResolved', paths: string[]) =>
    void changeIndex(repoId, host.rpc.call(method, { repoId, paths })).catch((error: unknown) =>
      toast(method === 'index.unstage' ? 'Could not unstage' : 'Could not stage', {
        kind: 'error',
        detail: errorText(error),
      }),
    );
  const stage = (paths: string[]) => call('index.stage', paths);
  const unstage = (paths: string[]) => call('index.unstage', paths);
  const discard = (paths: string[]) => void runOperation({ kind: 'discard', paths });

  const groups: {
    kind: GroupKind;
    title: string;
    files: readonly ChangedFile[];
    base: string | undefined;
    target: string;
    allTitle: string;
  }[] = data
    ? [
        {
          kind: 'conflicts',
          title: 'Conflicts',
          files: data.conflicted,
          base: headRev,
          target: 'WORKTREE',
          allTitle: 'Conflicts',
        },
        {
          kind: 'staged',
          title: 'Staged',
          files: data.staged,
          base: headRev,
          target: 'INDEX',
          allTitle: 'Staged changes',
        },
        {
          kind: 'changes',
          title: 'Changes',
          files: data.unstaged,
          base: 'INDEX',
          target: 'WORKTREE',
          allTitle: 'Unstaged changes',
        },
        {
          kind: 'untracked',
          title: 'Untracked',
          files: data.untracked,
          base: undefined,
          target: 'WORKTREE',
          allTitle: 'Untracked files',
        },
      ]
    : [];
  const all = data ? [...data.conflicted, ...data.staged, ...data.unstaged] : [];

  const fileActions = (kind: GroupKind) => (file: ChangedFile) => {
    // Each button names its file for screen readers (every row has the same buttons).
    const path = file.path;
    switch (kind) {
      case 'staged':
        return (
          <FileAction
            icon="remove"
            label="Unstage"
            name={`Unstage ${path}`}
            onClick={() => unstage([path])}
          />
        );
      case 'changes':
        if (file.submodule)
          return <SubmoduleFileActions repoId={repoId} file={file} onStage={() => stage([path])} />;
        return (
          <>
            <FileAction
              icon="discard"
              label="Discard changes…"
              name={`Discard changes to ${path}…`}
              danger
              onClick={() => discard([path])}
            />
            <FileAction icon="add" label="Stage" name={`Stage ${path}`} onClick={() => stage([path])} />
          </>
        );
      case 'untracked':
        return (
          <>
            <FileAction
              icon="trash"
              label="Delete file…"
              name={`Delete ${path}…`}
              danger
              onClick={() => discard([path])}
            />
            <FileAction icon="add" label="Stage" name={`Stage ${path}`} onClick={() => stage([path])} />
          </>
        );
      case 'conflicts':
        return (
          <FileAction
            icon="check"
            label="Mark resolved (stage)"
            name={`Mark ${path} resolved (stage)`}
            onClick={() => call('conflict.markResolved', [path])}
          />
        );
    }
  };

  const groupActions = (kind: GroupKind, files: readonly ChangedFile[]) => {
    const paths = files.map((file) => file.path);
    switch (kind) {
      case 'staged':
        return <ActionButton icon="remove" label="Unstage all" onClick={() => unstage(paths)} />;
      case 'changes':
        return (
          <>
            <ActionButton
              icon="discard"
              label="Discard all…"
              title="Discard all unstaged changes (Undo brings them back)"
              collapsible
              // Submodules are not discarded like files (updating one puts it back).
              disabled={files.every((file) => file.submodule)}
              onClick={() => discard(files.filter((file) => !file.submodule).map((file) => file.path))}
            />
            {/* A submodule whose folder is gone is checked out again, not staged as removed. */}
            <ActionButton
              icon="add"
              label="Stage all"
              onClick={() =>
                stage(
                  files.filter((file) => !(file.submodule && file.status === 'D')).map((file) => file.path),
                )
              }
            />
          </>
        );
      case 'untracked':
        return <ActionButton icon="add" label="Stage all" onClick={() => stage(paths)} />;
      default:
        return null;
    }
  };

  // The lists scroll above the commit box; in a short pane the whole pane scrolls instead, so
  // the lists keep their room.
  return (
    <div className={styles.workingTree}>
      <div className={styles.changes}>
        <header className={styles.header}>
          <h2 className={styles.subject}>Uncommitted changes</h2>
          <div className={styles.when}>
            {head.detached
              ? 'Detached HEAD'
              : head.branch
                ? head.unborn
                  ? `No commits yet on ${head.branch}`
                  : `On branch ${head.branch}`
                : null}
            {tree
              ? ` · ${[
                  tree.conflicted ? `${tree.conflicted} conflicted` : '',
                  tree.staged ? `${tree.staged} staged` : '',
                  tree.unstaged ? `${tree.unstaged} modified` : '',
                  tree.untracked ? `${tree.untracked} untracked` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}`
              : null}
          </div>
          <div className={styles.chips}>
            <ActionButton
              icon="diff-multiple"
              label="Open all changes"
              primary
              disabled={all.length === 0}
              title="Every change since HEAD (staged and unstaged) in a multi-file diff"
              onClick={() =>
                openAllDiffs(
                  host.rpc,
                  repoId,
                  'Uncommitted changes',
                  // One entry per path: staged and unstaged edits of a file collapse into HEAD ↔ disk.
                  [...new Map(all.map((file) => [file.path, file])).values()],
                  headRev,
                  'WORKTREE',
                )
              }
            />
            <ActionButton
              icon="git-stash"
              label="Stash…"
              title="Set these changes aside on the stash list (git stash push)"
              disabled={
                !data || (all.length === 0 && data.untracked.length === 0) || data.conflicted.length > 0
              }
              onClick={() =>
                void runOperation({ kind: 'stashPush', includeUntracked: (data?.untracked.length ?? 0) > 0 })
              }
            />
            {stashCount > 0 ? (
              <ActionButton
                icon="list-unordered"
                label={`${stashCount} stash${stashCount === 1 ? '' : 'es'}`}
                title="Show the stash list"
                onClick={showStashes}
              />
            ) : null}
          </div>
        </header>
        {!data ? (
          changes.error ? (
            <ErrorLine error={changes.error} />
          ) : (
            <LoadingLine />
          )
        ) : (
          groups
            .filter((group) => group.files.length > 0)
            .map((group) => (
              <Section
                key={group.title}
                title={group.title}
                count={group.files.length}
                stats={group.kind === 'untracked' ? undefined : totals(group.files)}
                actions={
                  <>
                    {groupActions(group.kind, group.files)}
                    <ActionButton
                      icon="diff-multiple"
                      label="Open all"
                      title={`Open the ${group.allTitle.toLowerCase()} in a multi-file diff`}
                      collapsible
                      onClick={() =>
                        openAllDiffs(host.rpc, repoId, group.allTitle, group.files, group.base, group.target)
                      }
                    />
                  </>
                }
              >
                <FileList
                  files={group.files}
                  untracked={group.kind === 'untracked'}
                  onOpen={(file) => openFileDiff(host.rpc, repoId, file, group.base, group.target)}
                  onContextMenu={(file, event) =>
                    fileMenu(
                      file,
                      event,
                      () => openFileDiff(host.rpc, repoId, file, group.base, group.target),
                      group.kind === 'conflicts'
                        ? []
                        : [
                            {
                              id: 'stash-file',
                              label: 'Stash this file…',
                              icon: 'git-stash',
                              hint: `git stash push -- ${file.path}`,
                              onSelect: () =>
                                void runOperation({
                                  kind: 'stashPush',
                                  paths: [file.path],
                                  includeUntracked: group.kind === 'untracked',
                                }),
                            },
                          ],
                    )
                  }
                  actions={fileActions(group.kind)}
                  expansion={
                    group.kind === 'conflicts'
                      ? undefined
                      : inlineDiffs(group.kind, (file) =>
                          openFileDiff(host.rpc, repoId, file, group.base, group.target),
                        )
                  }
                />
              </Section>
            ))
        )}
        {data && all.length === 0 && data.untracked.length === 0 ? (
          <Notice>The working tree is clean.</Notice>
        ) : null}
      </div>
      <CommitBox
        repoId={repoId}
        branch={head.branch}
        head={head.sha}
        staged={data?.staged.length ?? tree?.staged ?? 0}
        conflicted={data?.conflicted.length ?? tree?.conflicted ?? 0}
        refreshing={changes.loading}
      />
    </div>
  );
}

// ---- two commits ----------------------------------------------------------------------------

type CompareMode = 'two-dot' | 'three-dot';

function CompareDetails({
  repoId,
  model,
  from,
  to,
  onReveal,
  onHighlight,
  onOpenCompare,
  scope,
}: DetailsPaneProps & { from: string; to: string }) {
  const host = useHost();
  const [swapped, setSwapped] = useState(false);
  const [mode, setMode] = useState<CompareMode>('two-dot');
  // With the working tree on one side, compare the commit with the files on disk (in that
  // direction: git cannot use the working tree as the "before" side).
  const worktree = isWorkingTreeSha(from) || isWorkingTreeSha(to);
  const aRev = worktree ? (isWorkingTreeSha(from) ? to : from) : swapped ? to : from;
  const bRev = worktree ? 'WORKTREE' : swapped ? from : to;

  const summary = useQuery<CompareSummary | { files: readonly ChangedFile[] }>(
    `${repoId}:${aRev}:${bRev}:${mode}`,
    (signal) =>
      worktree
        ? host.rpc
            .call('diff.files', { repoId, base: aRev, target: 'WORKTREE' }, { signal })
            .then((files) => ({ files }))
        : host.rpc.call('compare.summary', { repoId, a: aRev, b: bRev, mode }, { signal }),
  );
  const data = summary.loading ? undefined : summary.data;
  const compare = data && 'mode' in data ? data : undefined;
  const files = data?.files ?? [];
  // Diffs read "before → after": the merge base (three-dot) or A, to B.
  const base = !worktree && mode === 'three-dot' ? (compare?.mergeBase ?? aRev) : aRev;
  const target = bRev;

  const highlightSide = async (include: string, exclude: string) => {
    const shas = await host.rpc.call('compare.commits', { repoId, include, exclude, limit: 5000 });
    onHighlight(shas);
  };

  return (
    <div className={styles.scroll}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>
          <Icon name="git-compare" /> Comparing two {worktree ? 'states' : 'commits'}
        </div>
        <div className={styles.compareGrid}>
          <span className={styles.compareLabel}>from</span>
          <CommitChip model={model} sha={aRev} onClick={() => onReveal(aRev)} />
          <button
            type="button"
            className={styles.swap}
            title="Swap sides"
            aria-label="Swap sides"
            disabled={worktree}
            onClick={() => setSwapped((value) => !value)}
          >
            <Icon name="arrow-swap" />
          </button>
          <span className={styles.compareLabel}>to</span>
          {worktree ? (
            <span className={styles.worktreeChip}>
              <Icon name="edit" /> Working tree
            </span>
          ) : (
            <CommitChip model={model} sha={bRev} onClick={() => onReveal(bRev)} />
          )}
        </div>
        {!worktree ? (
          <div className={styles.segmented} role="radiogroup" aria-label="Comparison">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'two-dot'}
              title={`Direct difference between the two snapshots (git diff ${shortSha(aRev)} ${shortSha(bRev)})`}
              onClick={() => setMode('two-dot')}
            >
              Direct difference
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'three-dot'}
              title={`Changes on “to” since the common ancestor (git diff ${shortSha(aRev)}...${shortSha(bRev)})`}
              onClick={() => setMode('three-dot')}
            >
              Since common ancestor
            </button>
          </div>
        ) : null}
        {compare ? (
          <div className={styles.divergence}>
            <button
              type="button"
              className={styles.countLink}
              disabled={compare.onlyInB === 0}
              title="Highlight these commits in the graph"
              onClick={() => void highlightSide(bRev, aRev)}
            >
              <strong>{compare.onlyInB}</strong> commit{compare.onlyInB === 1 ? '' : 's'} only in “to”
            </button>
            <button
              type="button"
              className={styles.countLink}
              disabled={compare.onlyInA === 0}
              title="Highlight these commits in the graph"
              onClick={() => void highlightSide(aRev, bRev)}
            >
              <strong>{compare.onlyInA}</strong> only in “from”
            </button>
            {compare.mergeBase ? (
              <span className={styles.mergeBase}>
                common ancestor{' '}
                <button type="button" className={styles.link} onClick={() => onReveal(compare.mergeBase!)}>
                  {shortSha(compare.mergeBase)}
                </button>
              </span>
            ) : (
              <span className={styles.mergeBase}>no common ancestor</span>
            )}
          </div>
        ) : null}
      </header>
      <Section
        title="Files changed"
        count={data ? files.length : undefined}
        stats={data ? totals(files) : undefined}
        actions={
          <>
            <TreeToggle />
            <ActionButton
              icon="diff-multiple"
              label="Open all"
              disabled={files.length === 0}
              onClick={() =>
                openAllDiffs(
                  host.rpc,
                  repoId,
                  `${sideLabel(base)} ↔ ${sideLabel(target)}`,
                  files,
                  base,
                  target,
                )
              }
            />
          </>
        }
      >
        {data ? (
          <FileList
            files={files}
            emptyText="No differences."
            onOpen={(file) => openFileDiff(host.rpc, repoId, file, base, target)}
            onContextMenu={(file, event) =>
              fileMenu(file, event, () => openFileDiff(host.rpc, repoId, file, base, target), [], scope)
            }
          />
        ) : summary.error ? (
          <ErrorLine error={summary.error} />
        ) : (
          <LoadingLine text="Comparing…" />
        )}
      </Section>
      {!worktree ? (
        <div className={styles.footer}>
          <ActionButton
            icon="split-horizontal"
            label="Open in a Compare tab"
            title="Side-by-side commit lists and changes in a tab of its own"
            onClick={() => onOpenCompare(aRev, bRev)}
          />
        </div>
      ) : null}
    </div>
  );
}

// ---- several commits ------------------------------------------------------------------------

interface Cumulative {
  /** Net changes over one line of history. */
  readonly files: readonly ChangedFile[];
  readonly base?: string;
  readonly target?: string;
  /** For scattered selections: which selected commits touch each file. */
  readonly touchedBy?: ReadonlyMap<string, readonly string[]>;
}

/** True when the rows form one first-parent chain (each one's first parent is the next). */
function isLinear(model: LogModel, rows: readonly number[]): boolean {
  for (let i = 0; i < rows.length - 1; i++) {
    const row = rows[i]!;
    if (model.topology.parentCount(row) === 0 || model.topology.parentRow(row, 0) !== rows[i + 1])
      return false;
  }
  return true;
}

const SCATTERED_LIMIT = 60;
/** Commits listed by name in a large selection (the rest are counted). */
const CHIP_LIMIT = 200;

function CumulativeDetails({ repoId, model, selection, onReveal, scope }: DetailsPaneProps) {
  const host = useHost();
  const rows = useMemo(
    () =>
      selection
        .map((sha) => model.rowOf(sha))
        .filter((row) => row >= 0)
        .sort((x, y) => x - y),
    [model, selection],
  );
  const linear = rows.length === selection.length && isLinear(model, rows);
  const newest = rows.length > 0 ? model.sha(rows[0]!) : undefined;
  const oldestRow = rows[rows.length - 1];
  const base = linear && oldestRow !== undefined ? model.firstParent(oldestRow) : undefined;
  const target = newest && isWorkingTreeSha(newest) ? 'WORKTREE' : newest;
  const commits = selection.filter((sha) => !isWorkingTreeSha(sha));

  const result = useQuery<Cumulative>(`${repoId}:${linear}:${selection.join(',')}`, async (signal) => {
    if (linear && target) {
      const files = await host.rpc.call('diff.files', { repoId, base, target }, { signal });
      return { files, base, target };
    }
    // Scattered: every file the commits touch, and which commits touch it.
    const touchedBy = new Map<string, string[]>();
    const byPath = new Map<string, ChangedFile>();
    const details = await Promise.all(
      commits.slice(0, SCATTERED_LIMIT).map((sha) => fetchCommitDetails(host.rpc, repoId, sha)),
    );
    for (const commit of details) {
      for (const file of commit.files) {
        const list = touchedBy.get(file.path);
        if (list) list.push(commit.sha);
        else touchedBy.set(file.path, [commit.sha]);
        const known = byPath.get(file.path);
        byPath.set(
          file.path,
          known
            ? {
                ...known,
                additions: known.additions + file.additions,
                deletions: known.deletions + file.deletions,
              }
            : file,
        );
      }
    }
    return { files: [...byPath.values()].sort((x, y) => x.path.localeCompare(y.path)), touchedBy };
  });
  const data = result.loading ? undefined : result.data;

  const metas = commits.map((sha) => model.metaOf(sha)).filter((meta): meta is CommitMeta => !!meta);
  const authors = [...new Map(metas.map((meta) => [meta.authorEmail.toLowerCase(), meta])).values()];
  const times = metas.map((meta) => meta.authorTime);
  const span =
    times.length > 0
      ? (() => {
          const first = new Date(Math.min(...times) * 1000);
          const last = new Date(Math.max(...times) * 1000);
          const format = (date: Date) =>
            date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
          return format(first) === format(last) ? format(first) : `${format(first)} – ${format(last)}`;
        })()
      : undefined;

  const openScatteredFile = (file: ChangedFile, event?: MouseEvent) => {
    const shas = data?.touchedBy?.get(file.path) ?? [];
    const openIn = (sha: string) => {
      void fetchCommitDetails(host.rpc, repoId, sha).then((details) => {
        const changed = details.files.find((f) => f.path === file.path) ?? file;
        openFileDiff(host.rpc, repoId, changed, details.diffBase, sha);
      });
    };
    if (shas.length === 1) {
      openIn(shas[0]!);
      return;
    }
    const anchor = event ? { x: event.clientX, y: event.clientY } : { x: 200, y: 200 };
    openMenu(anchor, [
      { kind: 'header', label: `${file.path} changed in` },
      ...shas.map((sha): MenuEntry => ({
        id: sha,
        label: model.metaOf(sha)?.subject ?? shortSha(sha),
        hint: shortSha(sha),
        icon: 'git-commit',
        onSelect: () => openIn(sha),
      })),
    ]);
  };

  return (
    <div className={styles.scroll}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>
          <Icon name="layers" /> {selection.length} commits selected
        </div>
        <div className={styles.authors}>
          <span className={styles.avatarStack}>
            {authors.slice(0, 5).map((meta) => (
              <Avatar key={meta.authorEmail} name={meta.author} email={meta.authorEmail} size={22} />
            ))}
          </span>
          <span className={styles.when}>
            {authors.length === 1 ? authors[0]!.author : `${authors.length} authors`}
            {span ? ` · ${span}` : null}
          </span>
        </div>
        {linear ? (
          <Notice icon="arrow-down">
            One line of history — showing the <strong>combined changes</strong> from{' '}
            {base ? shortSha(base) : 'the beginning'} to {sideLabel(target)}.
          </Notice>
        ) : (
          <Notice icon="git-pull-request-draft">
            These commits are not one line of history, so there is no single combined diff. Showing every file
            they touch{commits.length > SCATTERED_LIMIT ? ` (first ${SCATTERED_LIMIT} commits)` : ''}.
          </Notice>
        )}
      </header>
      <Section
        title={linear ? 'Combined changes' : 'Files touched'}
        count={data ? data.files.length : undefined}
        stats={data && linear ? totals(data.files) : undefined}
        actions={
          <>
            <TreeToggle />
            {linear ? (
              <ActionButton
                icon="diff-multiple"
                label="Open all"
                disabled={!data || data.files.length === 0}
                onClick={() =>
                  data &&
                  openAllDiffs(
                    host.rpc,
                    repoId,
                    `${sideLabel(base)} ↔ ${sideLabel(target)} (${selection.length} commits)`,
                    data.files,
                    base,
                    target!,
                  )
                }
              />
            ) : null}
          </>
        }
      >
        {data ? (
          <FileList
            files={data.files}
            onOpen={(file) =>
              linear ? openFileDiff(host.rpc, repoId, file, base, target!) : openScatteredFile(file)
            }
            onContextMenu={(file, event) =>
              fileMenu(
                file,
                event,
                () =>
                  linear
                    ? openFileDiff(host.rpc, repoId, file, base, target!)
                    : openScatteredFile(file, event),
                [],
                scope,
              )
            }
            badge={
              linear
                ? undefined
                : (file) => {
                    const count = data.touchedBy?.get(file.path)?.length ?? 0;
                    return count > 1 ? (
                      <span
                        className={styles.touchCount}
                        title={`Changed in ${count} of the selected commits`}
                      >
                        ×{count}
                      </span>
                    ) : null;
                  }
            }
          />
        ) : result.error ? (
          <ErrorLine error={result.error} />
        ) : (
          <LoadingLine text="Collecting changes…" />
        )}
      </Section>
      <Section title="Commits" count={commits.length}>
        <div className={styles.commitList}>
          {commits.slice(0, CHIP_LIMIT).map((sha) => (
            <CommitChip key={sha} model={model} sha={sha} onClick={() => onReveal(sha)} />
          ))}
          {commits.length > CHIP_LIMIT ? (
            <span className={styles.more}>and {commits.length - CHIP_LIMIT} more</span>
          ) : null}
        </div>
      </Section>
    </div>
  );
}
