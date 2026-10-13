import { Fragment, memo, useMemo } from 'react';
import { tokenizeCommand } from '../../shared/shell';
import styles from './CommandLine.module.css';

export interface CommandLineProps {
  readonly args: readonly string[];
  /** Wrap long commands (between words) instead of truncating with an ellipsis. */
  readonly wrap?: boolean;
  /** Empty arguments are fields not filled in yet: shown as a faint ellipsis, not as ''. */
  readonly placeholders?: boolean;
  readonly className?: string;
}

/** A git command rendered with theme-aware syntax highlighting. */
export const CommandLine = memo(function CommandLine({
  args,
  wrap,
  placeholders,
  className,
}: CommandLineProps) {
  const tokens = useMemo(() => tokenizeCommand(args), [args]);
  return (
    <span className={[styles.line, wrap ? styles.wrap : '', className ?? ''].join(' ')}>
      {tokens.map((token, index) => {
        const pending = placeholders && token.text === "''";
        return (
          <Fragment key={index}>
            {/* Between the words: where a wrapped command breaks. */}
            {index > 0 ? ' ' : null}
            <span className={[styles.word, pending ? styles.pending : styles[token.kind]].join(' ')}>
              {pending ? '…' : token.text}
            </span>
          </Fragment>
        );
      })}
    </span>
  );
});
