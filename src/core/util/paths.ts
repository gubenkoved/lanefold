import * as path from 'node:path';

/**
 * File-path comparisons the way VS Code makes them: without regard to case on Windows and macOS
 * (`c:\repo` from an editor and `C:\Repo` from git are one folder there).
 */
export interface PathRules {
  /** Whether `a` and `b` name the same location. */
  same(a: string, b: string): boolean;
  /**
   * `file` relative to `folder` with forward slashes ('' for the folder itself), or undefined
   * when it is not inside. The result keeps the case of `file`.
   */
  relativeInside(folder: string, file: string): string | undefined;
}

export function pathRules(platform: NodeJS.Platform): PathRules {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const ignoreCase = platform === 'win32' || platform === 'darwin';
  const fold = (part: string) => (ignoreCase ? part.toLowerCase() : part);
  const parts = (value: string) =>
    api
      .resolve(value)
      .split(api.sep)
      .filter((part) => part !== '');
  const relativeInside = (folder: string, file: string): string | undefined => {
    const base = parts(folder);
    const target = parts(file);
    if (target.length < base.length) return undefined;
    for (const [index, part] of base.entries()) if (fold(part) !== fold(target[index]!)) return undefined;
    return target.slice(base.length).join('/');
  };
  return {
    same: (a, b) => relativeInside(a, b) === '',
    relativeInside,
  };
}

/** The rules of the platform this runs on. */
export const paths: PathRules = pathRules(process.platform);
