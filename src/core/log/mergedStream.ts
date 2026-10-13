import { GitError } from '../git/errors';
import type { GitRunner } from '../git/runner';
import type { LogEndInfo } from './logEngine';
import type { MergedTopologyParser } from './mergedParser';

/** One rev-list of a merged log. */
export interface MergedSourceSpec {
  readonly cwd: string;
  readonly args: readonly string[];
  /** Starting commits fed through `--stdin`. */
  readonly stdin?: string;
}

export interface MergedStreamResult {
  /** Streams that ended with an error, by index. */
  readonly sourceErrors: Readonly<Record<number, string>>;
  readonly cancelled: boolean;
}

/**
 * Runs one rev-list per source into a merged parser, all at once; settles when every one of
 * them ended. A stream that fails does not stop the others: the rows it read are kept.
 */
export async function streamMerged(
  runnerOf: (index: number) => GitRunner,
  sources: readonly MergedSourceSpec[],
  parser: MergedTopologyParser,
  signal: AbortSignal,
): Promise<MergedStreamResult> {
  const sourceErrors: Record<number, string> = {};
  let cancelled = false;
  await Promise.all(
    sources.map((source, index) =>
      Promise.resolve()
        .then(() =>
          runnerOf(index).stream(
            {
              cwd: source.cwd,
              args: source.args,
              stdin: source.stdin,
              readOnly: true,
              label: 'Load history',
              signal,
            },
            (data) => parser.push(index, data),
          ),
        )
        .then(
          () => undefined,
          (error: unknown) => {
            if (error instanceof GitError && error.kind === 'cancelled') cancelled = true;
            else sourceErrors[index] = error instanceof Error ? error.message : String(error);
          },
        )
        .then(() => {
          if (!signal.aborted) parser.end(index);
        }),
    ),
  );
  return { sourceErrors, cancelled: cancelled || signal.aborted };
}

/** How a merged log ended: it failed only if no stream could be read at all. */
export function mergedEndInfo(
  rowCount: number,
  result: MergedStreamResult,
  sources: number,
  durationMs: number,
): LogEndInfo {
  const errors = Object.values(result.sourceErrors);
  return {
    rowCount,
    durationMs,
    cancelled: result.cancelled || undefined,
    error: !result.cancelled && sources > 0 && errors.length === sources ? errors[0] : undefined,
    sourceErrors: errors.length > 0 ? result.sourceErrors : undefined,
  };
}
