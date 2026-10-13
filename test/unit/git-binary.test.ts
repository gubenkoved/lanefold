import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  featuresFor,
  findOnPath,
  isSupportedVersion,
  parseGitVersion,
  versionAtLeast,
} from '../../src/core/git/binary';

describe('parseGitVersion', () => {
  it.each([
    ['git version 2.43.0', [2, 43, 0]],
    ['git version 2.39.3 (Apple Git-145)', [2, 39, 3]],
    ['git version 2.45.1.windows.1', [2, 45, 1]],
    ['git version 2.30', [2, 30, 0]],
    ['git version 3.0.0-rc1\n', [3, 0, 0]],
  ])('parses %j', (output, [major, minor, patch]) => {
    const version = parseGitVersion(output);
    expect([version.major, version.minor, version.patch]).toEqual([major, minor, patch]);
    expect(version.raw).toBe(output.trim());
  });

  it('rejects unrelated output', () => {
    expect(() => parseGitVersion('hello')).toThrow(/Unrecognized/);
  });
});

describe('versionAtLeast / features', () => {
  const v = parseGitVersion('git version 2.38.1');

  it('compares component-wise', () => {
    expect(versionAtLeast(v, 2, 38)).toBe(true);
    expect(versionAtLeast(v, 2, 38, 1)).toBe(true);
    expect(versionAtLeast(v, 2, 38, 2)).toBe(false);
    expect(versionAtLeast(v, 2, 39)).toBe(false);
    expect(versionAtLeast(v, 1, 99)).toBe(true);
    expect(versionAtLeast(v, 3, 0)).toBe(false);
  });

  it('enables features by version', () => {
    expect(featuresFor(v)).toMatchObject({
      mergeTreeWriteTree: true,
      rebaseUpdateRefs: true,
      fixupWithMessage: true,
      mergeTreeMergeBase: false,
      forEachRefAheadBehind: false,
    });
    expect(featuresFor(parseGitVersion('git version 2.31.0')).fixupWithMessage).toBe(false);
  });

  it('knows the supported floor', () => {
    expect(isSupportedVersion(parseGitVersion('git version 2.30.0'))).toBe(true);
    expect(isSupportedVersion(parseGitVersion('git version 2.29.9'))).toBe(false);
  });
});

describe('findOnPath', () => {
  it('finds git on PATH as an absolute path, never in relative PATH entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lanefold-path-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      for (const folder of [dir, bin]) {
        writeFileSync(join(folder, 'git'), '#!/bin/sh\n');
        chmodSync(join(folder, 'git'), 0o755);
      }
      // "." (the repository, when git runs there) comes first but does not count.
      const env = { PATH: ['.', '', bin].join(':') };
      expect(findOnPath('git', env, 'linux')).toBe(join(bin, 'git'));
      expect(findOnPath('git', { PATH: '.' }, 'linux')).toBeUndefined();
      expect(findOnPath('nope', env, 'linux')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
