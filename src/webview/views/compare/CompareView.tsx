import { useMemo, useRef, useState, type Ref } from 'react';
import type { CompareSummary, RefsSnapshot, ViewConfig } from '../../../shared/models';
import { errorText } from '../../bridge/errorText';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { openPicker } from '../../components/Picker';
import { segmentedClass } from '../../components/Segmented';
import { Splitter, usePersistentSize } from '../../components/Splitter';
import { toast } from '../../components/Toast';
import { GraphPane } from '../../graph/GraphPane';
import type { GraphView } from '../../graph/GraphView';
import type { LogModel } from '../../graph/logModel';
import { useHost } from '../../hostContext';
import { useQuery, useRepoVersion } from '../../state/queries';
import { useApp } from '../../state/store';
import {
  compareTitle,
  revLabel,
  type CompareConfig,
  type CompareMode,
  type TabModel,
} from '../../state/tabs';
import { useFocusWhenShown } from '../../state/viewFocus';
import { DetailsPane } from '../log/DetailsPane';
import { openAllDiffs, openFileDiff } from '../log/diffActions';
import { FileList, totals, TreeToggle } from '../log/FileList';
import { fileMenu } from '../log/fileMenus';
import { openCompareTab, showRefMenu, showRowMenu } from '../log/logMenus';
import { STACK_BELOW, useElementWidth } from '../log/LogView';
import { ActionButton, ErrorLine, LoadingLine, Section } from '../log/parts';
import { useLogModel } from '../log/useLogModel';
import { customRevision, refPickerItems } from '../refItems';
import styles from './CompareView.module.css';

/** Changes what a compare tab compares; it is retitled unless the user named it. */
function setCompare(tab: TabModel, patch: Partial<CompareConfig>): void {
  const compare = { ...tab.compare!, ...patch };
  const automatic = tab.title === compareTitle(tab.compare!);
  useApp.getState().updateTab(tab.id, { compare, ...(automatic ? { title: compareTitle(compare) } : {}) });
}

const MODES: readonly CompareMode[] = ['three-dot', 'two-dot'];

function RevButton({
  label,
  rev,
  refs,
  loadRefs,
  onPick,
  buttonRef,
}: {
  label: string;
  rev: string;
  refs: RefsSnapshot | undefined;
  /** The branches and tags to choose from, read now if they are not yet. */
  loadRefs: () => Promise<RefsSnapshot>;
  onPick: (rev: string) => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const ref = refs?.refs.find((r) => r.short === rev);
  const icon = !rev
    ? 'add'
    : ref?.kind === 'tag'
      ? 'tag'
      : ref?.kind === 'remote'
        ? 'cloud'
        : ref
          ? 'git-branch'
          : 'git-commit';
  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.rev}
      data-empty={!rev}
      aria-haspopup="dialog"
      onClick={(event) => {
        const anchor = event.currentTarget;
        void loadRefs().then(
          (snapshot) =>
            openPicker(anchor, {
              title: `Compare ${label}`,
              placeholder: 'Branch, tag or commit hash',
              items: refPickerItems(snapshot, { includeHead: true }),
              custom: customRevision,
              onPick: ([value]) => value && onPick(value),
            }),
          (error: unknown) =>
            toast('Could not read the branches and tags', { kind: 'error', detail: errorText(error) }),
        );
      }}
      title={rev ? `${label}: ${rev}` : `Choose ${label}`}
      aria-label={`Compare ${label}: ${rev ? revLabel(rev) : 'Choose…'}`}
    >
      <span className={styles.revSide}>{label}</span>
      <Icon name={icon} />
      <span className={styles.revName}>{rev ? revLabel(rev) : 'Choose…'}</span>
      <Icon name="chevron-down" className={styles.chevron} />
    </button>
  );
}

/** One side's exclusive commits as a graph, or a one-line note when there are none. */
function SidePane({
  title,
  count,
  model,
  repoId,
  graphRef,
  onSelect,
}: {
  title: string;
  count: number | undefined;
  model: LogModel | undefined;
  repoId: string;
  graphRef: { current: GraphView | undefined };
  onSelect: (shas: readonly string[]) => void;
}) {
  const host = useHost();
  const empty = count === 0;
  return (
    <section className={styles.side} data-empty={empty}>
      <header className={styles.sideHeader}>
        <span className={styles.sideTitle}>{title}</span>
        {count !== undefined ? <span className={styles.count}>{count.toLocaleString()}</span> : null}
      </header>
      {empty ? (
        <div className={styles.none}>None — everything here is also on the other side.</div>
      ) : (
        <GraphPane
          className={styles.graph}
          model={model}
          animate
          graphRef={graphRef}
          label={title}
          onSelectionChange={(shas) => onSelect(shas)}
          onContextMenu={(row, x, y) =>
            model &&
            graphRef.current &&
            showRowMenu({ rpc: host.rpc, repoId, model, graph: graphRef.current }, row, x, y)
          }
          onRefClick={(ref, event) =>
            model &&
            graphRef.current &&
            showRefMenu({ rpc: host.rpc, repoId, model, graph: graphRef.current }, ref, event)
          }
        />
      )}
    </section>
  );
}

export interface CompareViewProps {
  readonly tab: TabModel;
  readonly repoId: string;
  readonly active: boolean;
}

/** A comparison of two revisions: what each has that the other lacks, and the file changes. */
export function CompareView({ tab, repoId, active }: CompareViewProps) {
  const host = useHost();
  const config = tab.compare!;
  const { a, b, mode } = config;
  const version = useRepoVersion(host.rpc, repoId);
  const refs = useQuery(`${repoId}:${version}`, () => host.rpc.call('repo.refs', { repoId }));
  const ready = a !== '' && b !== '';
  const summary = useQuery<CompareSummary>(
    ready ? `${repoId}:${a}:${b}:${mode}:${version}` : undefined,
    (signal) => host.rpc.call('compare.summary', { repoId, a, b, mode }, { signal }),
  );
  const data =
    summary.data && summary.data.a === a && summary.data.b === b && summary.data.mode === mode
      ? summary.data
      : undefined;

  const graphA = useRef<GraphView | undefined>(undefined);
  const graphB = useRef<GraphView | undefined>(undefined);
  const [selected, setSelected] = useState<{ side: 'a' | 'b'; shas: readonly string[] }>();
  const [paneWidth, setPaneWidth] = usePersistentSize('compare.width', 420);
  const [paneHeight, setPaneHeight] = usePersistentSize('compare.height', 260);
  const [rootRef, rootWidth] = useElementWidth<HTMLDivElement>();
  // Narrow panels put the changed files under the commits, as the log does.
  const stacked = rootWidth > 0 && rootWidth < STACK_BELOW;
  const fromButton = useRef<HTMLButtonElement>(null);
  const toButton = useRef<HTMLButtonElement>(null);
  // Opened from the New view menu: the side still to choose takes focus (Enter opens its list).
  useFocusWhenShown('compare', active, () => {
    (a ? toButton : fromButton).current?.focus();
    return true;
  });

  // Each side's exclusive commits: "b ^a" and "a ^b" (empty sides load nothing visible).
  const viewB = useMemo<ViewConfig>(
    () => ({ scope: { type: 'refs', refs: [b || 'HEAD', `^${a || 'HEAD'}`] } }),
    [a, b],
  );
  const viewA = useMemo<ViewConfig>(
    () => ({ scope: { type: 'refs', refs: [a || 'HEAD', `^${b || 'HEAD'}`] } }),
    [a, b],
  );
  const modelB = useLogModel(repoId, viewB, active && ready, () => graphB.current?.topRow ?? 0)?.model;
  const modelA = useLogModel(repoId, viewA, active && ready, () => graphA.current?.topRow ?? 0)?.model;
  const base = mode === 'three-dot' ? (data?.mergeBase ?? a) : a;
  const selectedModel = selected ? (selected.side === 'a' ? modelA : modelB) : undefined;

  // A side can be chosen as soon as the view shows: its list is read then if need be.
  const loadRefs = () => (refs.data ? Promise.resolve(refs.data) : host.rpc.call('repo.refs', { repoId }));
  const fromSide = (
    <RevButton
      label="from"
      rev={a}
      refs={refs.data}
      loadRefs={loadRefs}
      buttonRef={fromButton}
      onPick={(rev) => setCompare(tab, { a: rev })}
    />
  );
  const toSide = (
    <RevButton
      label="to"
      rev={b}
      refs={refs.data}
      loadRefs={loadRefs}
      buttonRef={toButton}
      onPick={(rev) => setCompare(tab, { b: rev })}
    />
  );

  if (!ready) {
    return (
      <div ref={rootRef} className={styles.root}>
        <div className={styles.toolbar}>
          {fromSide}
          <Icon name="arrow-right" className={styles.arrow} />
          {toSide}
        </div>
        <EmptyState
          icon="git-compare"
          title="Compare two branches or commits"
          description="Choose what to compare. You will see the commits each side has that the other doesn’t, and every file that changed."
        />
      </div>
    );
  }

  const files = data?.files ?? [];
  const stats = totals(files);
  return (
    <div ref={rootRef} className={styles.root}>
      <div className={styles.toolbar}>
        {fromSide}
        <button
          type="button"
          className={styles.swap}
          title="Swap sides"
          aria-label="Swap sides"
          onClick={() => setCompare(tab, { a: b, b: a })}
        >
          <Icon name="arrow-swap" />
        </button>
        {toSide}
        <div
          className={segmentedClass()}
          role="radiogroup"
          aria-label="Comparison"
          onKeyDown={(event) => {
            // One Tab stop; the arrow keys move the choice, as in any radio group.
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;
            setCompare(tab, { mode: next });
            event.currentTarget.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
          }}
        >
          <button
            type="button"
            role="radio"
            data-mode="three-dot"
            aria-checked={mode === 'three-dot'}
            tabIndex={mode === 'three-dot' ? 0 : -1}
            title={`What “to” changed since it diverged from “from” (git diff ${revLabel(a)}...${revLabel(b)})`}
            onClick={() => setCompare(tab, { mode: 'three-dot' })}
          >
            Since common ancestor
          </button>
          <button
            type="button"
            role="radio"
            data-mode="two-dot"
            aria-checked={mode === 'two-dot'}
            tabIndex={mode === 'two-dot' ? 0 : -1}
            title={`The direct difference between the two (git diff ${revLabel(a)} ${revLabel(b)})`}
            onClick={() => setCompare(tab, { mode: 'two-dot' })}
          >
            Direct difference
          </button>
        </div>
        {data ? (
          <span className={styles.baseInfo}>
            {data.mergeBase ? (
              <>
                common ancestor <code>{revLabel(data.mergeBase)}</code>
              </>
            ) : (
              'no common ancestor'
            )}
          </span>
        ) : null}
        {/* At the end of its line, also when a narrow toolbar wraps it onto one of its own. */}
        <span className={styles.end}>
          <ActionButton
            icon="diff-multiple"
            label="Open all changes"
            primary
            disabled={files.length === 0}
            onClick={() =>
              openAllDiffs(host.rpc, repoId, `${revLabel(base)} ↔ ${revLabel(b)}`, files, base, b)
            }
          />
        </span>
      </div>
      {summary.error ? (
        <ErrorLine error={summary.error} />
      ) : (
        <div className={styles.body} data-stacked={stacked}>
          <div className={styles.sides}>
            <SidePane
              title={`Only in ${revLabel(b)}`}
              count={data?.onlyInB}
              model={modelB}
              repoId={repoId}
              graphRef={graphB}
              onSelect={(shas) => setSelected(shas.length > 0 ? { side: 'b', shas } : undefined)}
            />
            <SidePane
              title={`Only in ${revLabel(a)}`}
              count={data?.onlyInA}
              model={modelA}
              repoId={repoId}
              graphRef={graphA}
              onSelect={(shas) => setSelected(shas.length > 0 ? { side: 'a', shas } : undefined)}
            />
          </div>
          <Splitter
            orientation={stacked ? 'horizontal' : 'vertical'}
            size={stacked ? paneHeight : paneWidth}
            min={stacked ? 140 : 280}
            max={900}
            defaultSize={stacked ? 260 : 420}
            onResize={stacked ? setPaneHeight : setPaneWidth}
            label="Resize changes"
          />
          <aside
            className={styles.files}
            style={stacked ? { height: paneHeight } : { width: paneWidth }}
            aria-label="Changes"
          >
            {selected && selectedModel ? (
              <div className={styles.selectedPane}>
                <button type="button" className={styles.back} onClick={() => setSelected(undefined)}>
                  <Icon name="arrow-left" /> Back to the comparison
                </button>
                <DetailsPane
                  repoId={repoId}
                  model={selectedModel}
                  selection={selected.shas}
                  onReveal={(sha) => void (selected.side === 'a' ? graphA : graphB).current?.goTo(sha)}
                  onHighlight={() => undefined}
                  onOpenCompare={(x, y) => openCompareTab(x, y, 'two-dot')}
                />
              </div>
            ) : (
              <Section
                title="Files changed"
                count={data ? files.length : undefined}
                stats={data ? stats : undefined}
                actions={<TreeToggle />}
              >
                {data ? (
                  <FileList
                    files={files}
                    emptyText={
                      mode === 'three-dot' ? `${revLabel(b)} has no changes of its own.` : 'No differences.'
                    }
                    onOpen={(file) => openFileDiff(host.rpc, repoId, file, base, b)}
                    onContextMenu={(file, event) =>
                      fileMenu(file, event, () => openFileDiff(host.rpc, repoId, file, base, b), [
                        {
                          id: 'open-at',
                          label: `Open it as in ${revLabel(b)}`,
                          icon: 'go-to-file',
                          disabled: file.status === 'D',
                          reason: `It is deleted in ${revLabel(b)}`,
                          onSelect: () =>
                            void host.rpc
                              .call('file.open', { repoId, path: file.path, rev: b })
                              .catch(() => undefined),
                        },
                      ])
                    }
                  />
                ) : (
                  <LoadingLine text="Comparing…" />
                )}
              </Section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
