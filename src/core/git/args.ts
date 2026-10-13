/**
 * Helpers that keep user-controlled values (ref names, paths, messages) from ever being
 * interpreted as git options, plus display formatting for the command previews.
 */

/** Characters git forbids in ref names (see `git check-ref-format`), plus control characters. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_REF_CHARS = /[\u0000- \u007f~^:?*[\\]/;

/**
 * Validates a ref name using git's documented rules. Returns an error message, or
 * `undefined` when the name is valid. Mirrors `git check-ref-format --branch` closely
 * enough for instant UI feedback; git itself remains the final authority.
 */
export function validateRefName(name: string): string | undefined {
  if (name.length === 0) return 'Name cannot be empty';
  if (name.startsWith('-')) return 'Name cannot start with “-”';
  if (name === '@') return 'Name cannot be “@”';
  if (FORBIDDEN_REF_CHARS.test(name))
    return 'Name contains a forbidden character (space, ~ ^ : ? * [ \\ or control)';
  if (name.includes('..')) return 'Name cannot contain “..”';
  if (name.includes('@{')) return 'Name cannot contain “@{”';
  if (name.includes('//')) return 'Name cannot contain “//”';
  if (name.startsWith('/') || name.endsWith('/')) return 'Name cannot start or end with “/”';
  if (name.endsWith('.')) return 'Name cannot end with “.”';
  for (const component of name.split('/')) {
    if (component.startsWith('.')) return 'A path component cannot start with “.”';
    if (component.endsWith('.lock')) return 'A path component cannot end with “.lock”';
  }
  return undefined;
}

/** Throws if `rev` could be parsed by git as an option. */
export function assertRevision(rev: string): string {
  if (rev.length === 0) throw new Error('Empty revision');
  if (rev.startsWith('-')) throw new Error(`Refusing revision that looks like an option: ${rev}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(rev)) throw new Error('Revision contains control characters');
  return rev;
}

/** `--end-of-options <revs...>` — everything after is a revision, never an option. */
export function revisions(...revs: string[]): string[] {
  return ['--end-of-options', ...revs.map(assertRevision)];
}

/** `-- <paths...>` — everything after is a pathspec (patterns like `src/*.ts` allowed). */
export function pathspecs(...paths: string[]): string[] {
  return paths.length === 0 ? [] : ['--', ...paths];
}

/** Characters that make git read a pathspec as a pattern, or as magic when it starts with ':'. */
const PATHSPEC_MAGIC = /[*?[\]\\]|^:/;

/**
 * `-- <files...>` for exact file paths (as git listed them). A name that git would read as a
 * pattern (`*.css`, `[draft].md`, `:notes`) is marked `:(literal)`, so an operation on that one
 * file can never touch other files.
 */
export function filePaths(...paths: readonly string[]): string[] {
  return paths.length === 0
    ? []
    : ['--', ...paths.map((path) => (PATHSPEC_MAGIC.test(path) ? `:(literal)${path}` : path))];
}

export { formatCommand, quoteShellArg } from '../../shared/shell';
