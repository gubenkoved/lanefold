import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  authorSearch,
  periodSearch,
  spanInWords,
  statsConfig,
  type ActivityBucket,
  type AuthorProfile,
  type LanguageStats,
  type StatsConfig,
  type StatsProgress,
  type StatsQuery,
  type StatsRange,
  type StatsResult,
} from '../../../shared/stats';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { absoluteTime, relativeLong } from '../../graph/format';
import { useHost } from '../../hostContext';
import { useQuery, useRepoVersion } from '../../state/queries';
import { useApp } from '../../state/store';
import type { TabModel } from '../../state/tabs';
import { useAnimationLevel } from '../../state/theme';
import { openFileHistoryTab } from '../log/logMenus';
import { useElementWidth } from '../log/LogView';
import { ActionButton, Avatar, ErrorLine, LoadingLine } from '../log/parts';
import { Segmented, type SegmentOption } from './Segmented';
import { ActivityChart, LanguageBar, PunchCard } from './StatsCharts';
import { ContributorList, HotspotList } from './StatsLists';
import {
  dateRange,
  dateText,
  hoursText,
  openLogSearch,
  percent,
  periodText,
  plural,
  STATS_ICON,
  UNIT_NAMES,
  WEEKDAYS,
} from './statsTab';
import styles from './StatsView.module.css';

const SCOPES: readonly SegmentOption<StatsConfig['scope']>[] = [
  { value: 'head', label: 'Current branch', title: 'The commits HEAD leads back to (git log HEAD)' },
  {
    value: 'all',
    label: 'All branches',
    title: 'Every branch, remote branch and tag (git log --branches --remotes --tags HEAD)',
  },
];

const RANGES: readonly SegmentOption<StatsRange>[] = [
  { value: 'all', label: 'All time' },
  { value: '12m', label: '12 months', title: 'The last 12 months' },
  { value: '3m', label: '3 months', title: 'The last 3 months' },
  { value: '30d', label: '30 days', title: 'The last 30 days' },
];

const RANGE_WORDS: Readonly<Record<StatsRange, string>> = {
  all: '',
  '12m': 'in the last 12 months',
  '3m': 'in the last 3 months',
  '30d': 'in the last 30 days',
};

/** Rows listed at first, and how many more "Show more" adds. */
const FIRST_ROWS = 10;
const MORE_CONTRIBUTORS = 25;
const MORE_FILES = 20;
/** Refreshes while lines are counted come at most this often (ms). */
const REFRESH_EVERY = 1000;

/** Views narrower than these drop to fewer columns. */
const WIDE = 1180;
const MEDIUM = 700;

function Section({
  title,
  note,
  actions,
  className,
  children,
}: {
  title: string;
  note?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={[styles.section, className ?? ''].join(' ')} aria-label={title}>
      <header className={styles.sectionHeader}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {note ? <span className={styles.sectionNote}>{note}</span> : null}
        <span className={styles.flex} />
        {actions}
      </header>
      {children}
    </section>
  );
}

function Tile({
  label,
  value,
  detail,
  title,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  title?: string;
}) {
  return (
    <div className={styles.tile} title={title}>
      <dt className={styles.tileLabel}>{label}</dt>
      <dd className={styles.tileValue}>{value}</dd>
      {detail ? <dd className={styles.tileDetail}>{detail}</dd> : null}
    </div>
  );
}

/**
 * A history without commits. On an unborn branch the other branches may have some: then they
 * are offered.
 */
function NoCommits({
  repoId,
  branch,
  onAllBranches,
}: {
  repoId: string;
  branch?: string;
  onAllBranches: () => void;
}) {
  const host = useHost();
  const refs = useQuery(branch !== undefined ? repoId : undefined, (signal) =>
    host.rpc.call('repo.refs', { repoId }, { signal }),
  );
  return (
    <EmptyState
      icon={STATS_ICON}
      title="No commits yet"
      description={
        branch
          ? `Statistics appear after the first commit on ${branch}.`
          : 'Statistics appear after the first commit.'
      }
      actions={
        refs.data && refs.data.refs.length > 0 ? (
          <ActionButton icon="source-control" label="All branches" onClick={onAllBranches} />
        ) : undefined
      }
    />
  );
}

/** "42 commits (35%) · Feb 2 – Jun 10, 2024 · most active on Tuesdays, usually 10:00–12:00". */
function profileLine(profile: AuthorProfile): string {
  const parts = [
    `${plural(profile.commits, 'commit')} (${percent(profile.share)})`,
    dateRange(profile.first, profile.last),
  ];
  // A habit needs a few commits to show.
  if (profile.commits >= 3) {
    const habits = [
      profile.weekday !== undefined ? `most active on ${WEEKDAYS[profile.weekday]}s` : '',
      profile.hours ? `usually ${hoursText(profile.hours)}` : '',
    ].filter(Boolean);
    if (habits.length > 0) parts.push(habits.join(', '));
  }
  return parts.join(' · ');
}

function AuthorHeader({ profile, onShowCommits }: { profile: AuthorProfile; onShowCommits: () => void }) {
  return (
    <section className={styles.author} aria-label={`About ${profile.name}`}>
      <Avatar name={profile.name} email={profile.email} size={36} />
      <div className={styles.authorText}>
        <h2 className={styles.authorName}>
          {profile.name} <span className={styles.authorEmail}>{profile.emails.join(', ')}</span>
        </h2>
        <p className={styles.authorLine}>{profileLine(profile)}</p>
      </div>
      <ActionButton icon="list-filter" label="Show commits" primary onClick={onShowCommits} />
    </section>
  );
}

function Summary({ result }: { result: StatsResult }) {
  const { summary, lines } = result;
  const partial = lines.counted < lines.total;
  // Nothing counted yet: the line numbers are still to come.
  const waiting = lines.pending && lines.counted === 0 && lines.total > 0;
  const counted = waiting
    ? 'being counted…'
    : partial
      ? `in the latest ${plural(lines.counted, 'commit')}`
      : `in ${plural(lines.counted, 'commit')}`;
  const spanDays =
    summary.first !== undefined && summary.last !== undefined
      ? Math.round((Date.UTC(...ymd(summary.last)) - Date.UTC(...ymd(summary.first))) / 86_400_000) + 1
      : 0;
  const net = summary.added - summary.removed;
  return (
    <dl className={styles.tiles}>
      <Tile
        label="Commits"
        value={summary.commits.toLocaleString()}
        detail={summary.merges > 0 ? plural(summary.merges, 'merge') : 'no merges'}
      />
      {result.author ? (
        <Tile label="Share" value={percent(result.author.share)} detail="of the commits shown" />
      ) : (
        <Tile
          label="Contributors"
          value={summary.contributors.toLocaleString()}
          detail={result.contributors.rows[0] ? `most: ${result.contributors.rows[0].name}` : undefined}
        />
      )}
      <Tile
        label="Lines added"
        value={waiting ? '—' : <span className={styles.plus}>+{summary.added.toLocaleString()}</span>}
        detail={counted}
      />
      <Tile
        label="Lines removed"
        value={waiting ? '—' : <span className={styles.minus}>−{summary.removed.toLocaleString()}</span>}
        detail={waiting ? counted : `net ${net >= 0 ? '+' : '−'}${Math.abs(net).toLocaleString()}`}
      />
      <Tile
        label="Files changed"
        value={waiting ? '—' : summary.files.toLocaleString()}
        detail={partial ? counted : undefined}
      />
      <Tile
        label="Active days"
        value={summary.activeDays.toLocaleString()}
        detail={spanDays > 0 ? `of ${plural(spanDays, 'day')}` : undefined}
      />
      <Tile
        label="First → last commit"
        value={summary.first !== undefined ? spanInWords(summary.first, summary.last!) : '—'}
        detail={summary.first !== undefined ? dateRange(summary.first, summary.last!) : undefined}
        title={
          summary.first !== undefined
            ? `${absoluteTime(summary.first)} → ${absoluteTime(summary.last!)}`
            : undefined
        }
      />
      <Tile
        label="Typical commit"
        value={summary.medianLines !== undefined ? plural(summary.medianLines, 'line') : '—'}
        detail={waiting ? counted : 'changed (the median)'}
      />
    </dl>
  );
}

/** Year, month (0-based) and day of a time, in the local calendar. */
function ymd(seconds: number): [number, number, number] {
  const date = new Date(seconds * 1000);
  return [date.getFullYear(), date.getMonth(), date.getDate()];
}

/** The progress line in the toolbar while the history is read or lines are counted. */
function progressText(
  progress: StatsProgress | undefined,
  loading: boolean,
  counting: boolean,
): string | undefined {
  if (progress?.phase === 'commits' && loading)
    return `Reading the history… ${plural(progress.done, 'commit')}`;
  if (loading) return 'Reading the history…';
  if (
    counting &&
    progress?.phase === 'lines' &&
    progress.total !== undefined &&
    progress.done < progress.total
  )
    return `Counting changed lines… ${progress.done.toLocaleString()} of ${plural(progress.total, 'commit')}`;
  if (counting) return 'Counting changed lines…';
  return undefined;
}

export interface StatsViewProps {
  readonly tab: TabModel;
  readonly repoId: string;
  readonly active: boolean;
}

/**
 * Statistics of the repository's history: overall or one author's, for the current branch or
 * every branch, all time or recent months. The host reads the commits (once, then only the new
 * ones) and counts lines for the newest commits in the background; this view shows aggregates.
 */
export function StatsView({ tab, repoId, active }: StatsViewProps) {
  const host = useHost();
  const config = statsConfig(tab.stats);
  const update = (patch: Partial<StatsConfig>) =>
    useApp.getState().updateTab(tab.id, { stats: { ...tab.stats, ...patch } });
  const version = useRepoVersion(host.rpc, repoId);
  const animate = useAnimationLevel() === 'full';
  const timeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }, []);
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  const layout = width === 0 || width >= WIDE ? 'wide' : width >= MEDIUM ? 'medium' : 'narrow';

  const [limits, setLimits] = useState({ contributors: FIRST_ROWS, files: FIRST_ROWS });
  const [linesVersion, setLinesVersion] = useState(0);
  const [progress, setProgress] = useState<StatsProgress>();

  const query: StatsQuery = {
    repoId,
    scope: config.scope,
    range: config.range,
    author: config.author,
    sort: config.sort,
    hotspots: config.hotspots,
    contributors: limits.contributors,
    files: limits.files,
    timeZone,
  };
  // What the numbers are of: while another selection loads, the last one's numbers are dimmed.
  const selection = JSON.stringify([config.scope, config.range, config.author, version]);
  // Lines are counted while the tab is in front; leaving it (or another scope) stops that.
  const counting = useQuery(active ? JSON.stringify([repoId, config.scope, version]) : undefined, (signal) =>
    host.rpc.call('stats.countLines', { repoId, scope: config.scope, refresh: true }, { signal }),
  );
  // The refs are read again when the repository changed since the last request, only then.
  const askedAt = useRef<number | undefined>(undefined);
  // The numbers come again as lines are counted (now and then), and once they all are.
  const counted = counting.loading ? 'counting' : counting.data ? 'counted' : 'idle';
  const stats = useQuery(
    active ? JSON.stringify([query, version, linesVersion, counted]) : undefined,
    async (signal) => {
      const refresh = askedAt.current !== version;
      askedAt.current = version;
      return { selection, result: await host.rpc.call('stats.get', { ...query, refresh }, { signal }) };
    },
  );
  const languages = useQuery<LanguageStats>(
    active ? JSON.stringify([repoId, version]) : undefined,
    (signal) => host.rpc.call('stats.languages', { repoId }, { signal }),
  );

  // Progress of this scope's reads.
  const refresh = useRef<{ timer?: ReturnType<typeof setTimeout>; last: number }>({ last: 0 });
  useEffect(() => {
    const state = refresh.current;
    const off = host.rpc.on('stats.progress', (next) => {
      if (next.repoId !== repoId || next.scope !== config.scope) return;
      setProgress(next);
      if (next.phase !== 'lines' || state.timer) return;
      state.timer = setTimeout(
        () => {
          state.timer = undefined;
          state.last = Date.now();
          setLinesVersion((value) => value + 1);
        },
        Math.max(0, REFRESH_EVERY - (Date.now() - state.last)),
      );
    });
    return () => {
      off();
      clearTimeout(state.timer);
      state.timer = undefined;
    };
  }, [host, repoId, config.scope]);
  const data = stats.data?.result;
  const stale = !!stats.data && stats.data.selection !== selection;
  const loading = !data || (stale && stats.loading);
  const showsProgress = active && (stats.loading || counting.loading) && (!!data || !stats.error);
  const status = showsProgress
    ? progressText(
        progress?.scope === config.scope ? progress : undefined,
        !data || stale,
        counting.loading && !!data?.lines.pending,
      )
    : undefined;

  const showCommits = () => {
    if (!config.author) return;
    const range = config.range !== 'all' && data?.summary.first !== undefined;
    const search = [
      authorSearch(config.author),
      range ? periodSearch(isoDay(data.summary.first!), isoDay(Date.now() / 1000)) : '',
    ].join(' ');
    openLogSearch(config.scope, data?.author?.name ?? config.author, search);
  };
  const openPeriod = (bucket: ActivityBucket) => {
    const search = [
      config.author ? authorSearch(config.author) : '',
      periodSearch(bucket.start, bucket.end),
    ].join(' ');
    const unit = data?.activity.unit ?? 'day';
    openLogSearch(config.scope, periodText(unit, bucket.start), search);
  };

  const filter = config.author ? (
    <span className={styles.chip}>
      <Icon name="person" />
      <span className={styles.chipText} title={config.author}>
        {config.author}
      </span>
      <button
        type="button"
        className={styles.chipClear}
        aria-label={`Show every author (stop showing only ${config.author})`}
        title="Show every author"
        onClick={() => update({ author: undefined })}
      >
        <Icon name="close" />
      </button>
    </span>
  ) : null;

  const toolbar = (
    <div className={styles.toolbar}>
      <span className={styles.title}>
        <Icon name={STATS_ICON} className={styles.titleIcon} />
        Statistics
      </span>
      <Segmented
        label="History"
        value={config.scope}
        options={SCOPES}
        onChange={(scope) => update({ scope })}
      />
      <Segmented
        label="Time range"
        value={config.range}
        options={RANGES}
        onChange={(range) => update({ range })}
      />
      {filter}
      <span className={styles.flex} />
      {/*
       * Always in place, the size of its spinner: progress coming and going never moves the view
       * (a narrow toolbar would wrap). Its words show where the toolbar has room to spare.
       */}
      <span className={styles.progress} aria-live="polite" title={status}>
        {status ? <Icon name="loading" spin /> : null}
        <span className={layout === 'wide' ? undefined : 'visually-hidden'}>{status}</span>
      </span>
    </div>
  );

  let body: ReactNode;
  if (stats.error && !data) body = <ErrorLine error={stats.error} />;
  else if (!data) body = <LoadingLine text={status ?? 'Reading the history…'} />;
  else if (data.scopeCommits === 0) {
    body = (
      <NoCommits
        repoId={repoId}
        branch={config.scope === 'head' && data.head.unborn ? data.head.branch : undefined}
        onAllBranches={() => update({ scope: 'all' })}
      />
    );
  } else if (data.summary.commits === 0) {
    const when = RANGE_WORDS[config.range];
    const where = config.scope === 'head' ? 'on this branch' : 'on any branch';
    body = (
      <EmptyState
        icon={STATS_ICON}
        title={
          config.author
            ? when
              ? `No commits by ${config.author} ${when}.`
              : `${config.author} has no commits ${where}.`
            : `No commits ${when || where}.`
        }
        description={config.range !== 'all' ? 'Older commits are counted in “All time”.' : undefined}
        actions={
          <>
            {config.range !== 'all' ? (
              <ActionButton icon="history" label="All time" onClick={() => update({ range: 'all' })} />
            ) : null}
            {config.author ? (
              <ActionButton icon="close" label="Every author" onClick={() => update({ author: undefined })} />
            ) : null}
          </>
        }
      />
    );
  } else {
    const { activity, lines } = data;
    const unit = UNIT_NAMES[activity.unit];
    body = (
      <div className={styles.content} data-stale={stale || undefined} aria-busy={loading || undefined}>
        {stats.error ? <ErrorLine error={stats.error} /> : null}
        {config.scope === 'head' && data.head.detached && data.head.sha ? (
          <p className={styles.notice}>
            <Icon name="info" />
            HEAD is detached at <code>{data.head.sha.slice(0, 8)}</code>: these are the commits it leads back
            to.
          </p>
        ) : null}
        {data.author ? <AuthorHeader profile={data.author} onShowCommits={showCommits} /> : null}
        <Summary result={data} />
        {lines.pending && counting.error ? (
          <ErrorLine error={`Changed lines could not be counted: ${counting.error}`} />
        ) : lines.counted < lines.total ? (
          <p className={styles.notice}>
            <Icon name="info" />
            {lines.pending
              ? 'Counting the lines each commit changed, the newest first: the numbers fill in as they come.'
              : `Lines counted for the latest ${lines.counted.toLocaleString()} of ${plural(lines.total, 'commit')} (merges aside).`}
          </p>
        ) : null}
        <Section
          title="Activity"
          note={`${config.activity === 'lines' ? 'lines' : 'commits'} per ${unit}`}
          actions={
            <Segmented
              label="Activity shows"
              value={config.activity}
              options={[
                { value: 'commits', label: 'Commits' },
                { value: 'lines', label: 'Lines' },
              ]}
              onChange={(activity) => update({ activity })}
            />
          }
        >
          {config.activity === 'lines' ? (
            <div className={styles.legendRow} aria-hidden="true">
              <span className={styles.key} data-kind="added" /> added
              <span className={styles.key} data-kind="removed" /> removed
            </div>
          ) : null}
          <ActivityChart
            key={JSON.stringify([config.scope, config.range, config.author, config.activity])}
            activity={activity}
            measure={config.activity}
            animate={animate}
            onOpen={openPeriod}
          />
        </Section>
        {/* Wide: two columns. Medium: the lists across, punch card and languages side by side. */}
        <div className={styles.sections} data-layout={layout}>
          <Section
            title="Contributors"
            note={plural(data.contributors.total, 'author')}
            className={styles.contributors}
            actions={
              <Segmented
                label="Order contributors by"
                value={config.sort}
                options={[
                  { value: 'commits', label: 'Commits' },
                  { value: 'lines', label: 'Lines' },
                  { value: 'recent', label: 'Recent', title: 'Most recent commit first' },
                ]}
                onChange={(sort) => update({ sort })}
              />
            }
          >
            <ContributorList
              rows={data.contributors.rows}
              total={data.contributors.total}
              author={config.author}
              onPick={(contributor) => update({ author: contributor.author })}
              onMore={() => setLimits({ ...limits, contributors: limits.contributors + MORE_CONTRIBUTORS })}
            />
          </Section>
          <Section
            title="Hotspots"
            note={
              lines.counted < lines.total ? `in the latest ${plural(lines.counted, 'commit')}` : undefined
            }
            className={styles.hotspots}
            actions={
              <Segmented
                label="Hotspots by"
                value={config.hotspots}
                options={[
                  { value: 'files', label: 'Files' },
                  { value: 'folders', label: 'Folders', title: 'Changes grouped by top-level folder' },
                ]}
                onChange={(hotspots) => update({ hotspots })}
              />
            }
          >
            {data.hotspots.rows.length > 0 ? (
              <HotspotList
                rows={data.hotspots.rows}
                total={data.hotspots.total}
                group={config.hotspots}
                onOpen={(hotspot) => openFileHistoryTab(hotspot.path)}
                onMore={() => setLimits({ ...limits, files: limits.files + MORE_FILES })}
              />
            ) : (
              <p className={styles.quiet}>
                {lines.pending ? 'Counting the changed files…' : 'No files changed in the commits counted.'}
              </p>
            )}
          </Section>
          <Section
            className={styles.punchCard}
            title="Punch card"
            note="weekday and hour, in each commit’s own time zone"
          >
            <PunchCard counts={data.punchCard} />
          </Section>
          <Section
            title="Languages"
            className={styles.languages}
            note={
              languages.data
                ? `${plural(languages.data.files, 'file')} in ${data.head.branch ?? 'HEAD'}`
                : undefined
            }
          >
            {languages.data && languages.data.files > 0 ? (
              <LanguageBar stats={languages.data} />
            ) : languages.error ? (
              <ErrorLine error={languages.error} />
            ) : languages.data ? (
              <p className={styles.quiet}>HEAD has no files.</p>
            ) : (
              <LoadingLine text="Reading HEAD’s files…" />
            )}
          </Section>
        </div>
        {data.summary.last !== undefined ? (
          <p className={styles.footnote}>
            Newest commit {relativeLong(data.summary.last)}, {dateText(data.summary.last)}. Days are your
            calendar’s; the punch card uses each commit’s own clock.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={styles.root} data-layout={layout} data-animate={animate || undefined}>
      {toolbar}
      <div className={styles.scroll}>{body}</div>
    </div>
  );
}

/** "2024-03-01" for a time, in the local calendar. */
function isoDay(seconds: number): string {
  const [year, month, day] = ymd(seconds);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
