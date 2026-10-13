/**
 * How a menu item's hint reads: a git command (shown after a `$` prompt), a value such as an
 * option, a revision or a path (shown as code), or a note in words ("new message, same changes").
 */
export function hintKind(hint: string): 'command' | 'code' | 'note' {
  if (/^git\s/.test(hint)) return 'command';
  // Words: a first word of letters followed by a space or a comma (not an all-caps "HEAD").
  if (/^[A-Za-z][a-z’']*[\s,]/.test(hint)) return 'note';
  return 'code';
}
