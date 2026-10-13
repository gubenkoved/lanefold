/** Display helpers for git command lines (previews, the Git Console, "copy as command"). */

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./^~{}-]+$/;

/** Quotes a single argument for display as a POSIX shell word. */
export function quoteShellArg(arg: string): string {
  if (arg.length === 0) return "''";
  // Braces are only special to the shell as brace expansion (`{a,b}` / `{1..3}`), so `@{u}` stays bare.
  const braceExpansion = /\{[^}]*(?:,|\.\.)[^}]*\}/.test(arg);
  if (SAFE_SHELL_WORD.test(arg) && !braceExpansion) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Hides credentials written into URLs (`https://user:token@host`, `https://token@host`) before a
 * command or its output is shown or logged. An ssh user name (`ssh://git@host`) is no secret.
 */
export function redactCredentials(text: string): string {
  return text.replace(
    /\b([a-z][a-z0-9+.-]*):\/\/([^\s/@'"]+)@/gi,
    (match, scheme: string, userinfo: string) =>
      /^https?$/i.test(scheme) || userinfo.includes(':') ? `${scheme}://***@` : match,
  );
}

/** Renders `git <args>` the way a user would type it in a terminal. */
export function formatCommand(args: readonly string[], program = 'git'): string {
  return [program, ...args].map(quoteShellArg).join(' ');
}

export type CommandTokenKind =
  'program' | 'config' | 'subcommand' | 'option' | 'value' | 'revision' | 'separator' | 'path' | 'text';

export interface CommandToken {
  readonly text: string;
  readonly kind: CommandTokenKind;
}

/** Options whose value is the following argument (so it is not mistaken for a revision). */
const OPTIONS_WITH_VALUE = new Set(['-m', '-F', '-C', '-c', '-X', '-s', '--author', '--format', '-u']);
/** Options whose following argument is itself a ref/revision. */
const OPTIONS_WITH_REVISION = new Set([
  '--onto',
  '-b',
  '-B',
  '--contains',
  '--merged',
  '--no-merged',
  '--points-at',
]);

/**
 * Splits a git command into tokens for syntax highlighting: `git -c k=v rebase -i --onto main HEAD~3 -- path`.
 * Leading `-c key=value` pairs (Lanefold's stable-output config) are tagged `config` so the UI can
 * de-emphasize or hide them.
 */
export function tokenizeCommand(args: readonly string[], program = 'git'): CommandToken[] {
  const tokens: CommandToken[] = [{ text: program, kind: 'program' }];
  let i = 0;
  while (i < args.length && args[i] === '-c' && i + 1 < args.length) {
    tokens.push({ text: '-c', kind: 'config' }, { text: quoteShellArg(args[i + 1]!), kind: 'config' });
    i += 2;
  }
  if (i < args.length) tokens.push({ text: quoteShellArg(args[i]!), kind: 'subcommand' });
  i++;
  let afterSeparator = false;
  let expect: 'value' | 'revision' | undefined;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    const text = quoteShellArg(arg);
    if (afterSeparator) tokens.push({ text, kind: 'path' });
    else if (arg === '--' || arg === '--end-of-options') {
      tokens.push({ text, kind: 'separator' });
      if (arg === '--') afterSeparator = true;
    } else if (expect) {
      tokens.push({ text, kind: expect });
      expect = undefined;
    } else if (arg.startsWith('-') && arg.length > 1) {
      tokens.push({ text, kind: 'option' });
      expect = OPTIONS_WITH_VALUE.has(arg)
        ? 'value'
        : OPTIONS_WITH_REVISION.has(arg)
          ? 'revision'
          : undefined;
    } else tokens.push({ text, kind: 'revision' });
  }
  return tokens;
}
