import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { ActivityBucket, ActivityMeasure, ActivitySeries, LanguageStats } from '../../../shared/stats';
import { useElementWidth } from '../log/LogView';
import { axisText, byteSize, percent, periodText, plural, UNIT_NAMES, WEEKDAYS } from './statsTab';
import styles from './StatsCharts.module.css';

/** The round number at or above `value` that a scale ends on: 1, 2, 5, 10, 20, 50… */
export function niceCeiling(value: number): number {
  if (value <= 0) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

/** The least share of the plot's height between two axis labels. */
const LABEL_ROOM = 0.12;

function linesText(bucket: ActivityBucket): string {
  return `+${bucket.added.toLocaleString()} −${bucket.removed.toLocaleString()}`;
}

/**
 * Commits (or lines added and removed) per period, as bars. Each bar is a button: hovering or
 * focusing it shows its numbers, and it opens the period's commits in a log. One tab stop; the
 * arrow keys move between periods.
 */
export function ActivityChart({
  activity,
  measure,
  animate,
  onOpen,
}: {
  activity: ActivitySeries;
  measure: ActivityMeasure;
  animate: boolean;
  /** Shows a period's commits (undefined: bars do nothing). */
  onOpen?: (bucket: ActivityBucket) => void;
}) {
  const { buckets, unit, linesFrom } = activity;
  const [rootRef, width] = useElementWidth<HTMLDivElement>();
  const [cursor, setCursor] = useState(buckets.length - 1);
  const [hovered, setHovered] = useState<number>();
  const [focused, setFocused] = useState<number>();
  const slots = useRef<(HTMLButtonElement | null)[]>([]);
  const count = buckets.length;
  const current = Math.min(Math.max(0, cursor), count - 1);
  const lines = measure === 'lines';
  const counted = (index: number) => linesFrom === undefined || index >= linesFrom;

  const commitScale = niceCeiling(Math.max(1, ...buckets.map((bucket) => bucket.commits)));
  // A line halfway up, where that is a whole number of commits.
  const halfway = Number.isInteger(commitScale / 2);
  const addedScale = niceCeiling(Math.max(0, ...buckets.map((bucket, i) => (counted(i) ? bucket.added : 0))));
  const removedScale = niceCeiling(
    Math.max(0, ...buckets.map((bucket, i) => (counted(i) ? bucket.removed : 0))),
  );
  const lineScale = addedScale + removedScale;
  // Added lines rise above the baseline, removed ones hang below it: one scale for both.
  const baseline = lineScale > 0 ? addedScale / lineScale : 0.5;
  const share = (value: number, scale: number) =>
    value > 0 && scale > 0 ? `max(2px, ${(value / scale) * 100}%)` : '0';

  const label = (bucket: ActivityBucket, index: number) => {
    const parts = [plural(bucket.commits, 'commit')];
    if (counted(index) && bucket.commits > 0)
      parts.push(`${bucket.added.toLocaleString()} lines added, ${bucket.removed.toLocaleString()} removed`);
    else if (!counted(index)) parts.push('lines not counted');
    return `${periodText(unit, bucket.start)}: ${parts.join(', ')}`;
  };

  const move = (to: number) => {
    const next = Math.min(count - 1, Math.max(0, to));
    setCursor(next);
    slots.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'PageDown') move(index + 10);
    else if (event.key === 'PageUp') move(index - 10);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(count - 1);
    else return;
    event.preventDefault();
  };

  // Axis labels as many as fit, the year shown where it changes.
  const fit = Math.max(2, Math.floor((width || 600) / 84));
  const step = Math.max(1, Math.ceil(count / fit));
  const ticks: { index: number; text: string }[] = [];
  let lastYear = '';
  for (let index = 0; index < count; index += step) {
    const year = buckets[index]!.start.slice(0, 4);
    ticks.push({ index, text: axisText(unit, buckets[index]!.start, year !== lastYear) });
    lastYear = year;
  }

  const tip = hovered ?? focused;
  const tipBucket = tip === undefined ? undefined : buckets[tip];
  const tipAt = tip === undefined ? 0 : ((tip + 0.5) / count) * 100;
  const uncountedWidth = lines && linesFrom !== undefined ? (linesFrom / count) * 100 : 0;

  return (
    <div ref={rootRef} className={styles.activity} data-animate={animate || undefined}>
      <div className={styles.plotRow}>
        <div className={styles.yAxis} aria-hidden="true">
          {lines ? (
            <>
              {/* An arm's end is labelled where it is not crowded against the baseline's. */}
              {addedScale > 0 && baseline >= LABEL_ROOM ? (
                <span style={{ top: 0 }}>+{addedScale.toLocaleString()}</span>
              ) : null}
              <span style={{ top: `${baseline * 100}%` }}>0</span>
              {removedScale > 0 && 1 - baseline >= LABEL_ROOM ? (
                <span style={{ top: '100%' }}>−{removedScale.toLocaleString()}</span>
              ) : null}
            </>
          ) : (
            <>
              <span style={{ top: 0 }}>{commitScale.toLocaleString()}</span>
              {halfway ? <span style={{ top: '50%' }}>{(commitScale / 2).toLocaleString()}</span> : null}
              <span style={{ top: '100%' }}>0</span>
            </>
          )}
        </div>
        <div className={styles.plot}>
          <span className={styles.grid} style={{ top: 0 }} />
          {!lines && halfway ? <span className={styles.grid} style={{ top: '50%' }} /> : null}
          <span className={styles.baseline} style={{ top: `${(lines ? baseline : 1) * 100}%` }} />
          {uncountedWidth > 0 ? (
            <span className={styles.uncounted} style={{ width: `${uncountedWidth}%` }} aria-hidden="true">
              {uncountedWidth * (width || 0) > 9000 ? <span>Lines not counted</span> : null}
            </span>
          ) : null}
          <div
            className={styles.bars}
            role="group"
            aria-label={
              lines ? `Lines added and removed per ${UNIT_NAMES[unit]}` : `Commits per ${UNIT_NAMES[unit]}`
            }
          >
            {buckets.map((bucket, index) => (
              <button
                key={bucket.start}
                ref={(element) => {
                  slots.current[index] = element;
                }}
                type="button"
                className={styles.slot}
                data-uncounted={(lines && !counted(index)) || undefined}
                tabIndex={index === current ? 0 : -1}
                aria-label={label(bucket, index)}
                aria-disabled={!onOpen || bucket.commits === 0 || undefined}
                style={{ '--i': Math.min(index, 60) } as CSSProperties}
                onPointerEnter={() => setHovered(index)}
                onPointerLeave={() => setHovered((value) => (value === index ? undefined : value))}
                onFocus={() => {
                  setCursor(index);
                  setFocused(index);
                }}
                onBlur={() => setFocused(undefined)}
                onClick={() => {
                  if (bucket.commits > 0) onOpen?.(bucket);
                }}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                {lines ? (
                  counted(index) ? (
                    <>
                      <span
                        className={styles.added}
                        style={{ bottom: `${(1 - baseline) * 100}%`, height: share(bucket.added, lineScale) }}
                      />
                      <span
                        className={styles.removed}
                        style={{ top: `${baseline * 100}%`, height: share(bucket.removed, lineScale) }}
                      />
                    </>
                  ) : null
                ) : (
                  <span className={styles.bar} style={{ height: share(bucket.commits, commitScale) }} />
                )}
              </button>
            ))}
          </div>
          {tipBucket ? (
            <div
              className={styles.tooltip}
              style={{ left: `${tipAt}%`, transform: `translateX(-${tipAt}%)` }}
              aria-hidden="true"
            >
              {lines && counted(tip!) ? (
                <>
                  <strong>{linesText(tipBucket)}</strong> lines
                  <span>{plural(tipBucket.commits, 'commit')}</span>
                </>
              ) : (
                <>
                  <strong>{plural(tipBucket.commits, 'commit')}</strong>
                  {counted(tip!) && tipBucket.commits > 0 ? <span>{linesText(tipBucket)} lines</span> : null}
                  {!counted(tip!) ? <span>lines not counted</span> : null}
                </>
              )}
              <span className={styles.tipPeriod}>{periodText(unit, tipBucket.start)}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className={styles.xAxis} aria-hidden="true">
        {ticks.map(({ index, text }) => {
          const at = ((index + 0.5) / count) * 100;
          return (
            <span
              key={index}
              style={{ left: `${at}%`, transform: `translateX(-${Math.min(100, Math.max(0, at))}%)` }}
            >
              {text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Commits by weekday and hour, in each commit's own time zone: a grid of cells shaded by count,
 * with a table of the same for screen readers.
 */
export function PunchCard({ counts }: { counts: readonly number[] }) {
  const max = Math.max(1, ...counts);
  const level = (value: number) => (value === 0 ? 0 : Math.max(1, Math.ceil((value / max) * 4)));
  const hour = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  const totals = WEEKDAYS.map((_, day) => counts.slice(day * 24, day * 24 + 24));
  return (
    <figure className={styles.punch}>
      <div className={styles.punchGrid} aria-hidden="true">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className={styles.hourLabel}>
            {h % 6 === 0 ? h : ''}
          </span>
        ))}
        {WEEKDAYS.map((day, d) => [
          <span key={day} className={styles.dayLabel}>
            {day.slice(0, 3)}
          </span>,
          ...totals[d]!.map((value, h) => (
            <span
              key={`${day}${h}`}
              className={styles.cell}
              data-level={level(value)}
              title={`${day}s ${hour(h)}–${hour(h + 1)}: ${plural(value, 'commit')}`}
            />
          )),
        ])}
      </div>
      <figcaption className={styles.punchLegend} aria-hidden="true">
        <span>Fewer</span>
        {[0, 1, 2, 3, 4].map((value) => (
          <span key={value} className={styles.cell} data-level={value} />
        ))}
        <span>More</span>
      </figcaption>
      <table className="visually-hidden">
        <caption>Commits by weekday, in each commit’s own time zone</caption>
        <thead>
          <tr>
            <th scope="col">Weekday</th>
            <th scope="col">Commits</th>
            <th scope="col">Busiest hour</th>
          </tr>
        </thead>
        <tbody>
          {WEEKDAYS.map((day, d) => {
            const values = totals[d]!;
            const total = values.reduce((sum, value) => sum + value, 0);
            const busiest = values.indexOf(Math.max(...values));
            return (
              <tr key={day}>
                <th scope="row">{day}</th>
                <td>{total.toLocaleString()}</td>
                <td>{total > 0 ? `${hour(busiest)}–${hour(busiest + 1)}` : 'none'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </figure>
  );
}

/** HEAD's files by language: one bar in parts (by size), and a legend that says the numbers. */
export function LanguageBar({ stats }: { stats: LanguageStats }) {
  const bySize = stats.bytes > 0;
  const total = bySize ? stats.bytes : stats.files;
  const color = (language: string, index: number) =>
    language === 'Other' ? 'var(--stats-other)' : `var(--stats-c${index + 1})`;
  return (
    <div className={styles.languages}>
      <div className={styles.languageBar} aria-hidden="true">
        {stats.languages.map((language, index) => (
          <span
            key={language.language}
            style={{
              flexGrow: bySize ? language.bytes : language.files,
              background: color(language.language, index),
            }}
            title={`${language.language}: ${percent((bySize ? language.bytes : language.files) / total)}`}
          />
        ))}
      </div>
      <ul className={styles.legend} aria-label="Languages">
        {stats.languages.map((language, index) => (
          <li key={language.language}>
            <span className={styles.swatch} style={{ background: color(language.language, index) }} />
            <span className={styles.languageName}>{language.language}</span>
            <span className={styles.languageShare}>
              {percent((bySize ? language.bytes : language.files) / total)}
            </span>
            <span className={styles.languageMeta}>
              {plural(language.files, 'file')} · {byteSize(language.bytes)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
