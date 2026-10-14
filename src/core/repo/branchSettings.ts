/*
 * A branch's own settings (`branch.<name>.<key>`: its upstream, mostly), which `git branch -d`
 * deletes along with the branch: kept with the deletion, so Undo brings them back too.
 */

import type { Repository } from './repository';

/** `[key, value]` pairs, keys in lower case (“remote”, “merge”). */
export type BranchSettings = readonly (readonly [string, string])[];

/** The settings brought back with a branch: where it pulls from and pushes to, and its description. */
const KEPT: ReadonlySet<string> = new Set(['remote', 'pushremote', 'merge', 'rebase', 'description']);

/**
 * The settings of `branch` in `git config -z --get-regexp` output (`key\nvalue` records, each
 * ending in NUL; a key set without a value has no newline). Branch names may hold dots: a key of
 * another branch whose name starts the same way leaves a dot in what follows the prefix.
 */
export function parseBranchSettings(output: string, branch: string): [string, string][] {
  const prefix = `branch.${branch}.`;
  const settings: [string, string][] = [];
  for (const record of output.split('\0')) {
    const newline = record.indexOf('\n');
    const name = newline < 0 ? record : record.slice(0, newline);
    if (!name.startsWith(prefix)) continue;
    const key = name.slice(prefix.length).toLowerCase();
    if (!KEPT.has(key)) continue;
    // A key without a value is a boolean that is on.
    settings.push([key, newline < 0 ? 'true' : record.slice(newline + 1)]);
  }
  return settings;
}

/**
 * The settings of a local branch worth bringing back with it: the repository's own, which git
 * deletes with the branch (not those of the user's or the system's settings).
 */
export async function readBranchSettings(repo: Repository, branch: string): Promise<[string, string][]> {
  return parseBranchSettings(await localBranchConfig(repo), branch);
}

/** {@link readBranchSettings} of several branches, read at once: those that have some. */
export async function readSettingsOfBranches(
  repo: Repository,
  branches: readonly string[],
): Promise<Record<string, BranchSettings>> {
  const output = await localBranchConfig(repo);
  const settings: Record<string, BranchSettings> = {};
  for (const branch of branches) {
    const values = parseBranchSettings(output, branch);
    if (values.length > 0) settings[branch] = values;
  }
  return settings;
}

/** The repository's own `branch.*` settings, as `git config -z --get-regexp` lists them. */
async function localBranchConfig(repo: Repository): Promise<string> {
  const result = await repo.git(['config', '--local', '-z', '--get-regexp', '^branch\\.'], {
    readOnly: true,
    background: true,
    label: 'Branch settings',
    // 1: none is set.
    okExitCodes: [0, 1],
  });
  return result.stdout;
}

/**
 * Puts a branch's settings back, unless it has some already (set since by someone else). Only
 * the keys Lanefold keeps are written, whatever `settings` holds.
 */
export async function restoreBranchSettings(
  repo: Repository,
  branch: string,
  settings: BranchSettings,
  label: string,
): Promise<void> {
  if ((await readBranchSettings(repo, branch)).length > 0) return;
  for (const [key, value] of settings) {
    if (!KEPT.has(key)) continue;
    await repo.git(['config', '--local', '--add', '--end-of-options', `branch.${branch}.${key}`, value], {
      label,
    });
  }
}

/** Deletes a branch's settings, as `git branch -d` does (when Redo deletes the branch again). */
export async function removeBranchSettings(repo: Repository, branch: string, label: string): Promise<void> {
  // 128: it has none.
  await repo.git(['config', '--local', '--remove-section', '--end-of-options', `branch.${branch}`], {
    label,
    okExitCodes: [0, 128],
  });
}
