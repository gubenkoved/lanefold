import type { ConsoleEntry } from '../../shared/models';

/** A row of the Git Console: one command, or one read-only query run several times at once. */
export interface ConsoleRowModel {
  /** The first run's id (the row stays where that run started). */
  readonly key: number;
  /** Every run, oldest first: one, or the repeats of a query within a burst of reads. */
  readonly runs: readonly ConsoleEntry[];
}

/** Commands of a burst start at most this long after the one before (ms). */
export const BURST_MS = 1000;

/**
 * The console's rows, oldest first. Views reloading together after a change ask git the same
 * things (where HEAD is, the remotes): within a burst of commands, a read-only query that ran
 * before folds into that run's row, which counts its runs. A command that changes the repository
 * ends the burst (what is read after it is new) and has a row of its own, as does every failed or
 * cancelled run.
 */
export function consoleRows(entries: readonly ConsoleEntry[], burstMs = BURST_MS): ConsoleRowModel[] {
  const rows: { key: number; runs: ConsoleEntry[] }[] = [];
  let burst = new Map<string, { key: number; runs: ConsoleEntry[] }>();
  let previous: number | undefined;
  for (const entry of entries) {
    if (previous === undefined || entry.startedAt - previous > burstMs) burst = new Map();
    previous = entry.startedAt;
    const foldable = entry.readOnly && (entry.state === 'ok' || entry.state === 'running');
    const command = `${entry.cwd}\0${entry.args.join('\0')}`;
    const row = foldable ? burst.get(command) : undefined;
    if (row) {
      row.runs.push(entry);
      continue;
    }
    const created = { key: entry.id, runs: [entry] };
    rows.push(created);
    if (foldable) burst.set(command, created);
    else if (!entry.readOnly) burst = new Map();
  }
  return rows;
}
