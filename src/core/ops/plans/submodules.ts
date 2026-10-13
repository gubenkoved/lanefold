/**
 * Plans of the submodule operations. They change other repositories (what the submodules have
 * checked out, the clones themselves) or settings, so they are not journaled: each plan says so.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { SubmoduleInfo } from '../../../shared/models';
import type { Operation } from '../../../shared/operations';
import { redactCredentials } from '../../../shared/shell';
import { filePaths, revisions, validateRefName } from '../../git/args';
import type { GitError } from '../../git/errors';
import { isSafeSubmodulePath, parseSubmoduleConfig } from '../../parsers/submodules';
import { gitInSubmodule, readGitmodules, readSubmodules } from '../../repo/submodules';
import { paths } from '../../util/paths';
import type { PlanBuilder, PlanContext } from '../planner';
import { plural, short } from './common';

/** "a", "a and b", "a, b and 2 more". */
function listOf(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, 2).join(', ')} and ${items.length - 2} more`;
}

/** "is"/"are" and "it"/"them" for a list of `n` things. */
const be = (n: number) => (n === 1 ? 'is' : 'are');
const them = (n: number) => (n === 1 ? 'it' : 'them');

const NOT_UNDOABLE =
  'This changes the submodules themselves (repositories of their own), which Undo cannot take back.';

/** The submodules an operation names (each must be one), or all of them when it names none. */
async function selectSubmodules(
  ctx: PlanContext,
  b: PlanBuilder,
  requested: readonly string[] | undefined,
): Promise<SubmoduleInfo[] | undefined> {
  const all = await readSubmodules(ctx.repo);
  if (all.length === 0) {
    b.block('This repository has no submodules.', { final: true });
    return undefined;
  }
  if (!requested?.length) return all;
  const selected: SubmoduleInfo[] = [];
  for (const path of requested) {
    // The commands use the paths read here, never the ones asked for.
    const found = all.find((submodule) => submodule.path === path);
    if (!found) b.block(`${String(path)} is not a submodule of this repository.`);
    else if (!selected.includes(found)) selected.push(found);
  }
  return selected;
}

/** How `git submodule update` updates each submodule, where this repository's settings say. */
async function updateModes(ctx: PlanContext): Promise<Map<string, string>> {
  const result = await ctx.repo
    .git(['config', '-z', '--get-regexp', '^submodule\\..*\\.update$'], {
      readOnly: true,
      background: true,
      okExitCodes: [0, 1],
    })
    .catch(() => undefined);
  return new Map(
    parseSubmoduleConfig(result?.stdout ?? '').flatMap((entry) =>
      entry.update ? [[entry.name, entry.update] as const] : [],
    ),
  );
}

/** What is worth knowing about a submodule whose HEAD the update moves. */
async function inspectMove(ctx: PlanContext, submodule: SubmoduleInfo) {
  const run = (args: string[], ok = [0, 1, 128]) =>
    gitInSubmodule(ctx.repo, submodule.path, args, ok).catch(() => undefined);
  const [branch, onlyHead, present] = await Promise.all([
    run(['symbolic-ref', '-q', '--short', 'HEAD']).then((result) =>
      result?.exitCode === 0 ? result.stdout.trim() : undefined,
    ),
    // Commits made on a detached HEAD: once it moves, only the reflog has them.
    submodule.checkedOut
      ? run(
          ['rev-list', '--count', '--not', '--branches', '--tags', '--remotes', '--not'].concat(
            revisions(submodule.checkedOut),
          ),
          [0],
        ).then((result) => Number(result?.stdout.trim()) || 0)
      : 0,
    submodule.recorded
      ? run(['cat-file', '-e', `${submodule.recorded}^{commit}`]).then((result) => result?.exitCode === 0)
      : true,
  ]);
  return { branch, onlyHead, present };
}

/** Where git fetches from (the settings' URL) when .gitmodules changed it since: worth a sync first. */
function staleUrl(b: PlanBuilder, submodule: SubmoduleInfo): void {
  if (submodule.settingsUrl)
    b.notice(
      'warning',
      `It still fetches from ${submodule.settingsUrl}, but .gitmodules says ${submodule.url} now: sync ${submodule.path}’s URL first if that is where it moved.`,
    );
}

export async function planUpdateSubmodules(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'updateSubmodules' }>,
  b: PlanBuilder,
): Promise<string> {
  const init = !!op.init;
  const explicit = !!op.paths?.length;
  const fallback = init ? 'Initialize and update submodules' : 'Update submodules';
  const selected = await selectSubmodules(ctx, b, op.paths);
  if (!selected) return fallback;
  const one = explicit && selected.length === 1 ? selected[0] : undefined;
  const title = one
    ? `${init && one.state === 'uninitialized' ? 'Initialize' : 'Update'} ${one.path}`
    : fallback;

  const conflicted = selected.filter((submodule) => submodule.state === 'conflicted');
  if (conflicted.length > 0)
    b.block(
      `${listOf(conflicted.map((s) => s.path))} ${conflicted.length === 1 ? 'has' : 'have'} a merge conflict: check out the commit to record in ${them(conflicted.length)}, then stage ${them(conflicted.length)} here.`,
    );
  const uninitialized = selected.filter((submodule) => submodule.state === 'uninitialized');
  if (uninitialized.length > 0 && !init) {
    const names = listOf(uninitialized.map((s) => s.path));
    if (explicit)
      b.block(
        `${names} ${be(uninitialized.length)} not initialized yet: initialize ${them(uninitialized.length)} too.`,
      );
    else
      b.notice(
        'info',
        `Not initialized, so left as ${them(uninitialized.length)} ${be(uninitialized.length)}: ${names}.`,
      );
  }
  const moving = selected.filter((submodule) => submodule.state === 'otherCommit');
  const cloning = init ? uninitialized : [];
  // Set up, but not checked out (a deleted folder, a clone that failed): checked out again.
  const restoring = selected.filter((submodule) => submodule.state === 'missing');
  if (!b.blocked && moving.length + cloning.length + restoring.length === 0 && !op.recursive)
    b.block(
      one
        ? `${one.path} is already at the commit this repository records.`
        : 'Every submodule is already at the commit this repository records.',
    );

  const args = ['submodule', 'update'];
  const flags: [string, string][] = [];
  if (init) {
    args.push('--init');
    flags.push(['--init', 'set up and clone the submodules not initialized yet']);
  }
  if (op.recursive) {
    args.push('--recursive');
    flags.push(['--recursive', 'also update the submodules inside them']);
  }
  if (explicit) args.push(...filePaths(...selected.map((submodule) => submodule.path)));
  b.command(
    args,
    one
      ? one.state === 'uninitialized'
        ? `Clone ${one.path} and check out ${short(one.recorded)}, the commit this repository records for it.`
        : one.state === 'missing'
          ? `Check out ${short(one.recorded)} in ${one.path} again: the commit this repository records for it.`
          : `Check out ${short(one.recorded)} in ${one.path}: the commit this repository records for it.`
      : `Check out in each submodule the commit this repository records for it${init ? ', cloning those not initialized yet' : ''}.`,
    flags,
  );

  const modes = moving.length > 0 ? await updateModes(ctx) : new Map<string, string>();
  for (const submodule of moving) {
    const { branch, onlyHead, present } = await inspectMove(ctx, submodule);
    const { path } = submodule;
    const mode = modes.get(submodule.name) ?? 'checkout';
    const from = short(submodule.checkedOut);
    const to = short(submodule.recorded);
    if (mode === 'rebase')
      b.notice(
        'info',
        `${path} is set to rebase: git replays ${branch ?? 'its HEAD'}’s own commits onto ${to}.`,
      );
    else if (mode === 'merge')
      b.notice('info', `${path} is set to merge: git merges ${to} into ${branch ?? 'its HEAD'}.`);
    else if (mode === 'none')
      b.notice('info', `${path} is set never to be updated (update = none): git leaves it at ${from}.`);
    else if (mode.startsWith('!'))
      b.notice(
        'warning',
        `${path} is updated by a command of your own (submodule.${submodule.name}.update).`,
      );
    else
      b.notice(
        'info',
        `${path}’s HEAD moves from ${from} to ${to}, detached from ${branch ? `${branch} (which stays where it is)` : 'any branch'}. Its commits stay in its branches and reflog.`,
      );
    if (onlyHead > 0) {
      b.risk('Leaves commits behind');
      b.notice(
        'warning',
        `${plural(onlyHead, 'commit')} checked out in ${path} ${be(onlyHead)} on no branch: afterwards only its reflog has ${them(onlyHead)}. Create a branch there first to keep ${them(onlyHead)} easy to find.`,
      );
    }
    if (!present) {
      b.notice(
        'info',
        `${path} does not have ${to} yet: git fetches it first (this may ask for credentials).`,
      );
      staleUrl(b, submodule);
    }
    if (submodule.modified || submodule.untracked)
      b.notice(
        'warning',
        `${path} has uncommitted changes. Git keeps them, but stops without changing anything there if they are in the way; commit or stash them inside ${path} first to be sure.`,
      );
    if (submodule.nested && !op.recursive)
      b.notice(
        'info',
        `${path} has submodules of its own: they stay as they are (update recursively to include them).`,
      );
  }
  for (const submodule of cloning)
    b.notice(
      'info',
      `${submodule.path} is cloned from ${submodule.url ?? 'the URL in .gitmodules'} (this may ask for credentials).`,
    );
  for (const submodule of restoring) {
    // Its repository may still be here (in .git/modules): then nothing is cloned.
    const kept = existsSync(join(ctx.repo.gitDir, 'modules', submodule.name));
    b.notice(
      'info',
      kept
        ? `${submodule.path} is not checked out (its folder is gone or empty): git checks it out again from its repository, kept in .git/modules.`
        : `${submodule.path} is not checked out: git clones it again from ${submodule.settingsUrl ?? submodule.url ?? 'its URL'} (this may ask for credentials).`,
    );
    if (!kept) staleUrl(b, submodule);
  }
  if (one && one.state === 'dirty')
    b.notice(
      'info',
      `${one.path} is at the recorded commit already; its uncommitted changes stay as they are.`,
    );
  b.notice('info', NOT_UNDOABLE);
  return title;
}

/** Plain local paths: git refuses to clone them as submodules unless allowed (protocol.file.allow). */
const LOCAL_URL = /^(?:file:|\/|~|[a-zA-Z]:[\\/]|\\\\)/;

export async function planAddSubmodule(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'addSubmodule' }>,
  b: PlanBuilder,
): Promise<string> {
  const url = String(op.url ?? '').trim();
  const typed = String(op.path ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const branch = typeof op.branch === 'string' && op.branch.trim() ? op.branch.trim() : undefined;
  // The folder as git sees it: relative to the repository root, forward slashes.
  const full = typed ? resolvePath(ctx.repo.root, typed) : undefined;
  const folder = full ? paths.relativeInside(ctx.repo.root, full) : undefined;
  const title = folder ? `Add the submodule ${folder}` : 'Add a submodule';

  if (!url) b.block('Enter the URL of the repository to add.', { field: 'url', missing: true });
  // eslint-disable-next-line no-control-regex
  else if (url.startsWith('-') || /[\u0000-\u001f\u007f]/.test(url))
    b.block('That URL cannot be used: it starts with “-” or has control characters.', { field: 'url' });
  else if (redactCredentials(url) !== url)
    b.block(
      'The URL holds a password or token, which would be written to .gitmodules for everyone to read. Leave it out: git asks for it when needed.',
      { field: 'url' },
    );

  if (!typed) b.block('Choose a folder for it.', { field: 'path', missing: true });
  else if (folder === undefined || folder === '')
    b.block(`${typed} is not a folder inside this repository.`, { field: 'path' });
  else if (!isSafeSubmodulePath(folder)) b.block(`A submodule cannot go in ${folder}.`, { field: 'path' });
  else {
    const [tracked, declared] = await Promise.all([
      ctx.repo.git(['ls-files', '-z', ...filePaths(folder)], { readOnly: true, background: true }),
      readGitmodules(ctx.repo),
    ]);
    const taken = declared.find(
      (entry) => folder === entry.path || folder.startsWith(`${entry.path}/`) || entry.name === folder,
    );
    if (taken) b.block(`${folder} is taken by the submodule ${taken.path}.`, { field: 'path' });
    else if (tracked.stdout.length > 0)
      b.block(`${folder} is already tracked in this repository.`, { field: 'path' });
    else if (existsSync(full!) && (!statSync(full!).isDirectory() || readdirSync(full!).length > 0))
      b.block(`${folder} already exists and is not an empty folder.`, { field: 'path' });
  }
  if (branch) {
    const error = validateRefName(branch);
    if (error) b.block(`Branch: ${error}.`, { field: 'branch' });
  }

  b.command(
    ['submodule', 'add', ...(branch ? ['-b', branch] : []), '--', url, folder || typed],
    `Clone ${url ? `“${redactCredentials(url)}”` : '…'} into ${folder || '…'} and record it as a submodule: .gitmodules and ${folder || 'the folder'} are staged, ready to commit.`,
    branch ? [['-b', `follow ${branch} (written to .gitmodules for later updates from it)`]] : [],
  );
  if (LOCAL_URL.test(url))
    b.notice(
      'warning',
      'Git refuses to clone a submodule from a local folder unless that is allowed (protocol.file.allow), so it may stop here.',
    );
  b.notice(
    'info',
    `Undo cannot take this back (it clones a repository). To remove it again: git rm -f ${folder || '<folder>'}.`,
  );
  return title;
}

export async function planSyncSubmodules(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'syncSubmodules' }>,
  b: PlanBuilder,
): Promise<string> {
  const explicit = !!op.paths?.length;
  const selected = await selectSubmodules(ctx, b, op.paths);
  if (!selected) return 'Sync submodule URLs';
  const one = explicit && selected.length === 1 ? selected[0] : undefined;
  if (selected.every((submodule) => submodule.state === 'uninitialized'))
    b.block(
      one
        ? `${one.path} is not initialized: it takes the URL in .gitmodules when it is.`
        : 'No submodule is initialized: they take the URLs in .gitmodules when they are.',
    );
  b.command(
    ['submodule', 'sync', ...(explicit ? filePaths(...selected.map((submodule) => submodule.path)) : [])],
    one
      ? `Copy ${one.path}’s URL from .gitmodules into this repository’s settings and into its own origin remote.`
      : 'Copy the submodules’ URLs from .gitmodules into this repository’s settings and into their own origin remotes.',
  );
  const changed = selected.filter(
    (submodule) => submodule.settingsUrl && submodule.state !== 'uninitialized',
  );
  for (const submodule of changed)
    b.notice('info', `${submodule.path}: ${submodule.settingsUrl} → ${submodule.url}.`);
  b.notice(
    'info',
    changed.length > 0
      ? 'Fetches and updates then use the URLs in .gitmodules.'
      : 'The settings already have the URLs in .gitmodules: this only resets the submodules’ own origin remotes to them.',
  );
  b.notice('info', 'This changes settings, which Undo cannot take back.');
  return one ? `Sync the URL of ${one.path}` : 'Sync submodule URLs';
}

export async function planDeinitSubmodules(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'deinitSubmodules' }>,
  b: PlanBuilder,
): Promise<string> {
  if (!op.paths?.length) {
    b.block('Choose the submodules whose files to remove.');
    return 'Deinitialize submodules';
  }
  const selected = await selectSubmodules(ctx, b, op.paths);
  if (!selected) return 'Deinitialize submodules';
  const one = selected.length === 1 ? selected[0] : undefined;
  for (const submodule of selected) {
    if (submodule.state === 'uninitialized')
      b.block(`${submodule.path} is not initialized: there is nothing to remove.`);
    else if (submodule.state === 'conflicted')
      b.block(`${submodule.path} has a merge conflict: resolve it first.`);
    else if (submodule.state === 'otherCommit')
      b.block(
        `${submodule.path} has another commit checked out than the one recorded here: git refuses (update it, or record that commit first).`,
      );
    else if (submodule.modified || submodule.untracked)
      b.block(`${submodule.path} has uncommitted changes: git refuses. Commit or stash them there first.`);
  }
  const names = listOf(selected.map((submodule) => submodule.path));
  b.command(
    ['submodule', 'deinit', ...filePaths(...selected.map((submodule) => submodule.path))],
    selected.every((submodule) => submodule.state === 'missing')
      ? `Forget the settings of ${names} (${one ? 'its' : 'their'} files are not checked out). ${one ? 'It stays' : 'They stay'} recorded here, not initialized.`
      : `Delete the files of ${names} and forget ${one ? 'its' : 'their'} settings. ${one ? 'It stays' : 'They stay'} recorded here, not initialized.`,
  );
  b.notice(
    'info',
    `${one ? 'Its' : 'Their'} repository is kept (in .git/modules): initializing ${them(selected.length)} again brings the files back without cloning.`,
  );
  b.notice('info', NOT_UNDOABLE);
  return one ? `Deinitialize ${one.path}` : 'Deinitialize submodules';
}

/** What a submodule operation did, for the toast (git leaves branches and HEAD here alone). */
export function submoduleMessage(operation: Operation): string | undefined {
  switch (operation.kind) {
    case 'updateSubmodules':
      return operation.paths?.length === 1
        ? `${operation.paths[0]} is at the commit this repository records.`
        : 'The submodules are at the commits this repository records.';
    case 'addSubmodule':
      return 'It is cloned; .gitmodules and its folder are staged: commit them to record it.';
    case 'syncSubmodules':
      return 'Fetches and updates now use the URLs in .gitmodules.';
    case 'deinitSubmodules':
      return 'Its files are removed; initialize it to bring them back.';
    default:
      return undefined;
  }
}

const SUBMODULE_KINDS = new Set<Operation['kind']>([
  'updateSubmodules',
  'addSubmodule',
  'syncSubmodules',
  'deinitSubmodules',
]);

/** Why a submodule operation failed, in plain words (undefined: git's own words will do). */
export function submoduleFailure(operation: Operation, error: GitError): string | undefined {
  if (!SUBMODULE_KINDS.has(operation.kind)) return undefined;
  const text = `${error.stderr}\n${error.stdout}`;
  const path = /submodule path '([^']+)'/.exec(text)?.[1] ?? /work tree '([^']+)'/.exec(text)?.[1];
  if (/transport 'file' not allowed/.test(text))
    return 'Git refuses to clone or fetch a submodule from a local folder unless that is allowed (protocol.file.allow, a safety default). Use a remote URL, or allow it in your git settings if you trust that folder.';
  if (error.kind === 'dirtyWorkTree' || error.kind === 'untrackedOverwritten') {
    const files = error.files.length > 0 ? ` (${error.files.slice(0, 3).join(', ')})` : '';
    return `Uncommitted changes in ${path ?? 'a submodule'}${files} are in the way: commit or stash them there first. Nothing was changed in it.`;
  }
  const missing = /Fetched in submodule path '([^']+)', but it did not contain ([0-9a-f]+)/.exec(text);
  if (missing)
    return `${missing[1]}’s remote does not have ${short(missing[2])}, the commit recorded here: it may not be pushed yet.`;
  if (/contains local modifications/.test(text))
    return `${path ?? 'The submodule'} has uncommitted changes or another commit checked out: git refuses to remove its files.`;
  // A clone that failed (a URL that is wrong, or gone): git's reason, and where it cloned from.
  const clone = /clone of '([^']+)' into submodule path '[^']+' failed/.exec(text);
  if (clone) {
    const reason = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^fatal: /.test(line) && !/clone of '|transport '/.test(line))
      ?.replace(/^fatal: /, '');
    const which =
      operation.kind === 'updateSubmodules' && operation.paths?.length === 1 ? ` ${operation.paths[0]}` : '';
    return `Could not clone${which} from ${clone[1]}${reason ? `: ${reason}` : ''}. Check its URL in .gitmodules (then sync it).`;
  }
  return undefined;
}
