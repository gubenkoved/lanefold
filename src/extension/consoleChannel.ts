import * as vscode from 'vscode';
import { formatCommand } from '../core/git/args';
import type { GitCommandListener } from '../core/git/runner';

/** Mirrors every git command into the "Lanefold" output channel (log format, with timing). */
export function createConsoleChannel(): { channel: vscode.LogOutputChannel; listener: GitCommandListener } {
  const channel = vscode.window.createOutputChannel('Lanefold', { log: true });
  const listener: GitCommandListener = {
    onCommandEnd: (event) => {
      const command = formatCommand(event.args);
      const timing = `${event.durationMs.toFixed(0)} ms`;
      if (event.cancelled) {
        channel.debug(`${command} — cancelled after ${timing}`);
      } else if (!event.failed) {
        // An exit code the caller expects is an answer, not an error (`symbolic-ref` on a
        // detached HEAD, `merge-base` of unrelated histories).
        const code = event.exitCode === 0 ? '' : `, exit ${event.exitCode}`;
        if (event.background) channel.trace(`${command} (${timing}${code})`);
        else if (event.readOnly) channel.debug(`${command} (${timing}${code})`);
        else
          channel.info(
            `${command} (${timing}${code})${event.stdoutTail ? `\n${event.stdoutTail.trimEnd()}` : ''}`,
          );
      } else {
        channel.error(`${command} — exit ${event.exitCode} (${timing})\n${event.stderr.trimEnd()}`);
      }
    },
  };
  return { channel, listener };
}
