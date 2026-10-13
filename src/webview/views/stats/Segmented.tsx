import { Segmented as Group, type SegmentOption } from '../../components/Segmented';
import styles from './StatsView.module.css';

export type { SegmentOption };

/** One choice of a few, in the statistics’ style (a radio group: see the shared one). */
export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
}) {
  return <Group {...props} className={styles.segmented} />;
}
