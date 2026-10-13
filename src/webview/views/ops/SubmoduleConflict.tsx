import type { OperationInProgress, SubmoduleConflict } from '../../../shared/operations';
import { errorText } from '../../bridge/errorText';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { shortSha } from '../../graph/format';
import { useHost } from '../../hostContext';
import { refreshOpState } from '../../state/operations';
import { showSubmoduleCommits } from '../log/submodules';
import styles from './OpBanner.module.css';

/** The sides of the conflict as the banner names them (see `sideLabels`). */
export interface ConflictSides {
  readonly current: string;
  readonly incoming: string;
  readonly currentName: string;
  readonly incomingName: string;
  readonly currentTitle: string;
  readonly incomingTitle: string;
}

/**
 * A side's button for a submodule: "Keep main" → "Keep main’s commit", "Use “Bump lib”" →
 * "Use the commit “Bump lib” records".
 */
function commitLabel(label: string): string {
  if (label === 'Keep current') return 'Keep the current commit';
  const quoted = /^(Keep|Use) (“.*”)$/.exec(label);
  return quoted ? `${quoted[1]} the commit ${quoted[2]} records` : `${label}’s commit`;
}

/**
 * A conflict over a submodule in the conflict banner. It has no text to merge, so no merge
 * editor: either side's commit is recorded for it (which resolves it), the two can be compared
 * in the submodule, and the commit checked out in it can be staged as the resolution.
 */
export function SubmoduleConflictRow({
  repoId,
  kind,
  conflict,
  sides,
}: {
  repoId: string;
  kind: OperationInProgress | undefined;
  conflict: SubmoduleConflict;
  sides: ConflictSides;
}) {
  const host = useHost();
  const { path, ours, theirs, checkedOut } = conflict;
  const done = kind === 'am' ? 'once the patches are applied' : `once the ${kind ?? 'operation'} is done`;

  const record = async (side: 'ours' | 'theirs') => {
    try {
      const result = await host.rpc.call('conflict.recordSubmodule', { repoId, path, side });
      void refreshOpState(repoId);
      toast(`${path} records ${shortSha(result.recorded)}`, {
        kind: 'success',
        detail:
          result.checkedOut === result.recorded
            ? 'Resolved: that is the commit checked out in it.'
            : result.checkedOut
              ? `Resolved. Its folder has ${shortSha(result.checkedOut)} checked out: update it ${done}, or check out ${shortSha(result.recorded)} in it.`
              : 'Resolved. It is not checked out here.',
        durationMs: result.checkedOut === result.recorded ? undefined : 9000,
      });
    } catch (error) {
      toast('Could not record that commit', { kind: 'error', detail: errorText(error) });
    }
  };

  const markResolved = async () => {
    try {
      await host.rpc.call('conflict.markResolved', { repoId, paths: [path] });
      void refreshOpState(repoId);
    } catch (error) {
      toast('Could not mark it resolved', { kind: 'error', detail: errorText(error) });
    }
  };

  return (
    <li className={styles.file}>
      <Icon name="file-submodule" className={styles.conflictIcon} />
      <button
        type="button"
        className={styles.path}
        disabled={!ours || !theirs}
        title={
          ours && theirs
            ? `Compare the two commits in ${path}: ${shortSha(ours)} (${sides.currentName}) and ${shortSha(theirs)} (${sides.incomingName})`
            : `A submodule: one side removed it`
        }
        onClick={() => void showSubmoduleCommits(repoId, path, { from: ours, to: theirs })}
      >
        {path}
      </button>
      <span className={styles.commits}>
        {shortSha(ours) || 'removed'} ↔ {shortSha(theirs) || 'removed'}
      </span>
      <span className={styles.actions}>
        <button
          type="button"
          className={styles.small}
          disabled={!ours}
          title={`${sides.currentTitle}: record its commit ${shortSha(ours)} for the submodule (this resolves the conflict)`}
          onClick={() => void record('ours')}
        >
          {commitLabel(sides.current)}
        </button>
        <button
          type="button"
          className={styles.small}
          disabled={!theirs}
          title={`${sides.incomingTitle}: record its commit ${shortSha(theirs)} for the submodule (this resolves the conflict)`}
          onClick={() => void record('theirs')}
        >
          {commitLabel(sides.incoming)}
        </button>
        <button
          type="button"
          className={[styles.small, styles.resolve].join(' ')}
          disabled={!checkedOut}
          title={
            checkedOut
              ? `Record the commit checked out in it, ${shortSha(checkedOut)}, as the resolution`
              : 'It is not checked out here: record one side’s commit instead'
          }
          onClick={() => void markResolved()}
        >
          <Icon name="check" /> Resolved
        </button>
      </span>
    </li>
  );
}
