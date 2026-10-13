import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import * as path from 'node:path';

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The full `git --version` output, e.g. "git version 2.43.0". */
  readonly raw: string;
}

export interface GitBinary {
  readonly path: string;
  readonly version: GitVersion;
}

/** Optional git capabilities that Lanefold enables based on the installed version. */
export interface GitFeatures {
  /** `git merge-tree --write-tree` (conflict prediction without touching the worktree). */
  readonly mergeTreeWriteTree: boolean;
  /** `git merge-tree --merge-base=<commit>` (step-by-step rebase simulation). */
  readonly mergeTreeMergeBase: boolean;
  /** `git rebase --update-refs` (rebasing stacked branches). */
  readonly rebaseUpdateRefs: boolean;
  /** `fixup -C` / `fixup -c` todo commands. */
  readonly fixupWithMessage: boolean;
  /** `for-each-ref --format=%(ahead-behind:<ref>)`. */
  readonly forEachRefAheadBehind: boolean;
  /** `git stash push --staged`. */
  readonly stashStaged: boolean;
  /** `git cat-file --use-mailmap` (applies .mailmap to raw commit identities). */
  readonly catFileMailmap: boolean;
  /** `git status --show-stash` in porcelain v2 output. */
  readonly statusShowStash: boolean;
}

export const MIN_SUPPORTED_GIT: Readonly<Pick<GitVersion, 'major' | 'minor' | 'patch'>> = {
  major: 2,
  minor: 30,
  patch: 0,
};

/**
 * Parses `git --version` output. Handles vendor suffixes such as
 * "git version 2.39.3 (Apple Git-145)" and "git version 2.45.1.windows.1".
 */
export function parseGitVersion(output: string): GitVersion {
  const raw = output.trim();
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!match) {
    throw new Error(`Unrecognized git version output: ${JSON.stringify(raw)}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    raw,
  };
}

export function versionAtLeast(version: GitVersion, major: number, minor: number, patch = 0): boolean {
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;
  return version.patch >= patch;
}

export function isSupportedVersion(version: GitVersion): boolean {
  return versionAtLeast(version, MIN_SUPPORTED_GIT.major, MIN_SUPPORTED_GIT.minor, MIN_SUPPORTED_GIT.patch);
}

export function featuresFor(version: GitVersion): GitFeatures {
  return {
    mergeTreeWriteTree: versionAtLeast(version, 2, 38),
    mergeTreeMergeBase: versionAtLeast(version, 2, 40),
    rebaseUpdateRefs: versionAtLeast(version, 2, 38),
    fixupWithMessage: versionAtLeast(version, 2, 32),
    forEachRefAheadBehind: versionAtLeast(version, 2, 41),
    stashStaged: versionAtLeast(version, 2, 35),
    catFileMailmap: versionAtLeast(version, 2, 38),
    statusShowStash: versionAtLeast(version, 2, 35),
  };
}

function probe(candidate: string): Promise<GitBinary | undefined> {
  return new Promise((resolve) => {
    execFile(candidate, ['--version'], { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      try {
        resolve({ path: candidate, version: parseGitVersion(stdout) });
      } catch {
        resolve(undefined);
      }
    });
  });
}

/**
 * A program name (`git`) looked up on PATH, as an absolute path. Spawning a bare name would make
 * Windows look in the working directory (a repository) first, and run a `git.exe` found there.
 */
export function findOnPath(
  name = 'git',
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const pathVariable = platform === 'win32' ? (env.Path ?? env.PATH) : env.PATH;
  const extensions = platform === 'win32' && !api.extname(name) ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (pathVariable ?? '').split(api.delimiter)) {
    // Relative entries (".") would again mean the working directory.
    if (!dir || !api.isAbsolute(dir)) continue;
    for (const extension of extensions) {
      const candidate = api.join(dir, `${name}${extension}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}

/**
 * Finds a working git executable. Candidates are tried in order (explicit setting, the
 * built-in Git extension's path, then `git` on PATH); the first that answers `--version` wins.
 */
export async function findGit(candidates: ReadonlyArray<string | null | undefined>): Promise<GitBinary> {
  const tried: string[] = [];
  for (const given of [...candidates, 'git']) {
    // A bare name ("git") is looked up on PATH here, never next to the repository.
    const candidate = given && !/[\\/]/.test(given) ? findOnPath(given) : given;
    if (!candidate || tried.includes(candidate)) continue;
    tried.push(candidate);
    const binary = await probe(candidate);
    if (binary) return binary;
  }
  throw new Error(
    tried.length > 0 ? `Git was not found. Tried: ${tried.join(', ')}` : 'Git was not found on PATH.',
  );
}
