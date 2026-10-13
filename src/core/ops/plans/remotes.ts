/**
 * Plans for managing the repository's remotes: add, rename, remove, change URL. They change git's
 * settings and remote branches, not history, so they are not journaled: each plan says how to
 * go back instead.
 */

import type { Operation, OperationResult, PlannedCommand } from '../../../shared/operations';
import { redactCredentials } from '../../../shared/shell';
import { revisions } from '../../git/args';
import {
  branchesTracking,
  readConfiguredRemotes,
  remoteBranchesOf,
  validateRemoteName,
  validateRemoteUrl,
  type ConfiguredRemote,
  type TrackingBranch,
} from '../../repo/remotes';
import type { Repository } from '../../repo/repository';
import type { PlanBuilder, PlanContext } from '../planner';

export type RemoteOperation = Extract<
  Operation,
  { kind: 'addRemote' | 'renameRemote' | 'removeRemote' | 'setRemoteUrl' }
>;

const REMOTE_KINDS: ReadonlySet<Operation['kind']> = new Set([
  'addRemote',
  'renameRemote',
  'removeRemote',
  'setRemoteUrl',
]);

export function isRemoteOperation(operation: Operation): operation is RemoteOperation {
  return REMOTE_KINDS.has(operation.kind);
}

/** A text parameter from the webview (anything else counts as empty). */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const remoteBranches = (n: number) => `${n} remote branch${n === 1 ? '' : 'es'}`;

/** "a", "a and b", "a, b and c"; past `max` items, "a, b, c, d, e and 3 more". */
function listOf(items: readonly string[], max = 5): string {
  if (items.length <= 1) return items.join('');
  if (items.length <= max) return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

const CREDENTIALS_NOTICE =
  'This URL holds a password or token: git keeps it as plain text in the repository’s settings (.git/config). Lanefold never shows it, but a credential helper keeps it safer.';

const settingsNotice = (back: string) =>
  `This changes the repository’s settings, not its history: Undo cannot take it back. ${back}`;

/**
 * The remote named `name`, or undefined after blocking the plan. A name configured by hand may
 * start with "-": `git remote rename` and `remove` cannot be given that safely (see
 * validateRemoteName).
 */
function findRemote(
  remotes: readonly ConfiguredRemote[],
  name: string,
  b: PlanBuilder,
): ConfiguredRemote | undefined {
  const remote = remotes.find((candidate) => candidate.name === name);
  if (!remote) b.block(`There is no remote named ${name}.`, { final: true });
  else if (name.startsWith('-'))
    b.block(`git would read the name ${name} as an option: rename or remove it in a terminal.`, {
      final: true,
    });
  else return remote;
  return undefined;
}

/** The branches tracking a remote, as a list of names. */
function trackingList(tracking: readonly TrackingBranch[]): string {
  return listOf(tracking.map((branch) => branch.branch));
}

export async function planAddRemote(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'addRemote' }>,
  b: PlanBuilder,
): Promise<string> {
  const name = text(op.name).trim();
  const url = text(op.url).trim();
  const shown = redactCredentials(url);
  const remotes = await readConfiguredRemotes(ctx.repo);
  const nameError = validateRemoteName(name);
  if (nameError) b.block(nameError, { field: 'name', missing: name === '' });
  else if (remotes.some((remote) => remote.name === name))
    b.block(`There is already a remote named ${name}.`, { field: 'name' });
  const urlError = validateRemoteUrl(url);
  if (urlError) b.block(urlError, { field: 'url', missing: url === '' });
  // "--": what follows is the name and the URL, whatever they look like.
  b.command(
    ['remote', 'add', '--', name, url],
    `Remember ${shown ? `“${shown}”` : 'the URL'} as ${name || 'the remote'}: fetch, pull and push can then use it by that name.`,
  );
  if (op.fetch === true) {
    b.command(
      ['fetch', name],
      `Download its branches and tags (its branches show up as ${name || '…'}/…). Your own branches and files do not change.`,
    );
  }
  const same = url ? remotes.find((remote) => remote.urls.includes(url)) : undefined;
  if (same) b.notice('info', `${same.name} already fetches from there.`);
  if (shown !== url) b.notice('warning', CREDENTIALS_NOTICE);
  b.notice('info', settingsNotice(`Removing ${name || 'the remote'} does.`));
  return name ? `Add remote ${name}` : 'Add a remote';
}

export async function planRenameRemote(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'renameRemote' }>,
  b: PlanBuilder,
): Promise<string> {
  const from = text(op.from);
  const to = text(op.to).trim();
  const title = to && to !== from ? `Rename remote ${from} to ${to}` : `Rename remote ${from}`;
  const remotes = await readConfiguredRemotes(ctx.repo);
  const remote = findRemote(remotes, from, b);
  if (!remote) return title;
  const nameError = validateRemoteName(to);
  const taken = remotes.some((other) => other.name === to);
  if (nameError) b.block(nameError, { field: 'to', missing: to === '' });
  else if (to === from) b.block(`Enter a new name for ${from}.`, { field: 'to', missing: true });
  else if (taken) b.block(`There is already a remote named ${to}.`, { field: 'to' });
  // No "--": older git takes these two arguments as they are (it would take "--" for a name),
  // newer git reads options first. Names never start with "-", so neither reads them as options.
  // Until a new name is typed, the command shows where it goes (it cannot run like that).
  b.command(
    ['remote', 'rename', from, to === from ? '' : to],
    `Rename the remote ${from} to ${to && to !== from ? to : '…'}; git moves its remote branches and settings along.`,
  );
  if (!nameError && to !== from && !taken) {
    // What follows the new name.
    const renamed = (name: string) =>
      name.startsWith(`${from}/`) ? `${to}${name.slice(from.length)}` : name;
    const branches = remoteBranchesOf(
      ctx.refs.refs,
      from,
      remotes.map((other) => other.name),
    ).map((ref) => renamed(ref.slice('refs/remotes/'.length)));
    if (branches.length > 0)
      b.notice(
        'info',
        `Its remote ${branches.length === 1 ? 'branch becomes' : 'branches become'} ${listOf(branches)}.`,
      );
    const tracking = await branchesTracking(ctx.repo, from);
    if (tracking.length > 0)
      b.notice(
        'info',
        `${trackingList(tracking)} ${tracking.length === 1 ? 'keeps' : 'keep'} tracking it (as ${listOf(tracking.map((branch) => renamed(branch.upstream)))}): pull and push go on working.`,
      );
  }
  // git renames the default fetch setting (+refs/heads/*:refs/remotes/<name>/*) only, and warns.
  const kept = remote.fetch.filter((refspec) => !refspec.includes(`:refs/remotes/${from}/`));
  if (kept.length > 0)
    b.notice(
      'warning',
      `git leaves its fetch setting (${listOf(kept)}) as it is: it does not name refs/remotes/${from}/. Change it by hand if it should follow.`,
    );
  b.notice('info', settingsNotice('Renaming it back does.'));
  return title;
}

/** Commits on these remote branches that no branch, tag, other remote branch or HEAD has. */
async function commitsOnlyOn(ctx: PlanContext, branches: readonly string[]): Promise<number> {
  const mine = new Set(branches);
  const others = ctx.refs.refs
    .filter((ref) => ref.kind === 'remote' && !mine.has(ref.name))
    .map((ref) => `^${ref.name}`);
  // Read from stdin, they count as given there (the "not" of the command line is not theirs).
  const result = await ctx.repo.git(
    [
      'rev-list',
      '--count',
      '--stdin',
      '--not',
      '--branches',
      '--tags',
      ...(ctx.head.sha ? revisions(ctx.head.sha) : []),
    ],
    {
      readOnly: true,
      background: true,
      label: 'Commits only on the remote',
      stdin: `${[...branches, ...others].join('\n')}\n`,
      okExitCodes: [0, 128],
    },
  );
  return result.exitCode === 0 ? Number(result.stdout.trim()) || 0 : 0;
}

export async function planRemoveRemote(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'removeRemote' }>,
  b: PlanBuilder,
): Promise<string> {
  const name = text(op.name);
  const title = `Remove remote ${name}`;
  const remotes = await readConfiguredRemotes(ctx.repo);
  const remote = findRemote(remotes, name, b);
  if (!remote) return title;
  const branches = remoteBranchesOf(
    ctx.refs.refs,
    name,
    remotes.map((other) => other.name),
  );
  const tracking = await branchesTracking(ctx.repo, name);
  const parts = [
    'its settings',
    branches.length > 0 ? `its ${remoteBranches(branches.length)}` : '',
    tracking.length > 0 ? 'the upstream of the branches tracking it' : '',
  ].filter(Boolean);
  // No "--", as for rename.
  b.command(['remote', 'remove', name], `Forget the remote ${name}: ${listOf(parts)}.`);
  b.risk(branches.length > 0 ? 'Deletes remote branches' : 'Forgets a remote');
  const url = remote.urls[0];
  const back = `add it again${url ? ` (${redactCredentials(url)})` : ''} and fetch`;
  if (branches.length > 0) {
    const names = branches.map((ref) => ref.slice('refs/remotes/'.length));
    const only = await commitsOnlyOn(ctx, branches);
    const one = branches.length === 1;
    const deleted = one
      ? `Its remote branch ${names[0]} is deleted here.`
      : `Its ${remoteBranches(branches.length)} are deleted here: ${listOf(names)}.`;
    const lost =
      only > 0
        ? ` ${only === 1 ? '1 commit is' : `${only} commits are`} only on ${one ? 'it' : 'them'}, so no branch here keeps ${only === 1 ? 'it' : 'them'}.`
        : '';
    const it = one ? 'it' : 'them';
    b.notice('danger', `${deleted}${lost} Undo cannot bring ${it} back: to get ${it} back, ${back}.`);
  }
  if (tracking.length > 0) {
    const upstreams = tracking.map((branch) => branch.upstream).join(', ');
    b.notice(
      'warning',
      `${trackingList(tracking)} ${tracking.length === 1 ? 'loses its' : 'lose their'} upstream (${upstreams}): pull needs one again, and the next push sets one.`,
    );
  }
  b.notice(
    'info',
    branches.length > 0
      ? 'Nothing changes on the remote itself.'
      : settingsNotice(`Nothing changes on the remote itself: to undo, ${back}.`),
  );
  return title;
}

export async function planSetRemoteUrl(
  ctx: PlanContext,
  op: Extract<Operation, { kind: 'setRemoteUrl' }>,
  b: PlanBuilder,
): Promise<string> {
  const name = text(op.name);
  const url = text(op.url).trim();
  const push = op.push === true;
  const title = push ? `Change the push URL of ${name}` : `Change the URL of ${name}`;
  const remote = (await readConfiguredRemotes(ctx.repo)).find((candidate) => candidate.name === name);
  if (!remote) {
    b.block(`There is no remote named ${name}.`, { final: true });
    return title;
  }
  const urlError = validateRemoteUrl(url);
  if (urlError) b.block(urlError, { field: 'url', missing: url === '' });
  const fetchUrl = remote.urls[0];
  const pushUrl = remote.pushUrls[0] ?? fetchUrl;
  // Without the URL to replace, set-url sets the one value: git refuses when there are several.
  const current = push ? remote.pushUrls : remote.urls;
  if (current.length > 1)
    b.block(
      `${name} has ${current.length} ${push ? 'push URLs' : 'URLs'}: change them in a terminal (git remote set-url --add, --delete).`,
    );
  else if (!urlError && url === (push ? pushUrl : fetchUrl))
    b.block(push ? `Pushes to ${name} already go there.` : `${name} already fetches from there.`, {
      field: 'url',
      // The sheet opens with the URL it has: nothing changed yet.
      missing: true,
    });
  const show = (value: string | undefined) => (value === undefined ? 'no URL' : redactCredentials(value));
  const shown = url ? `“${redactCredentials(url)}”` : '…';
  // "--", as for add. The name needs no check here: set-url reads options in every git version.
  b.command(
    ['remote', 'set-url', ...(push ? ['--push'] : []), '--', name, url],
    push
      ? `Push to ${shown} when pushing to ${name}.`
      : `Fetch from ${shown} as ${name}${remote.pushUrls.length > 0 ? '' : ', and push there'}.`,
    push ? [['--push', 'only where pushes go: fetching keeps its URL']] : [],
  );
  if (push) b.notice('info', `Fetching keeps using ${show(fetchUrl)}.`);
  else if (remote.pushUrls.length > 0)
    b.notice('info', `Pushes keep going to ${show(remote.pushUrls[0])} (its push URL).`);
  if (redactCredentials(url) !== url) b.notice('warning', CREDENTIALS_NOTICE);
  const previous = push ? pushUrl : fetchUrl;
  const hidden = previous !== undefined && show(previous) !== previous;
  b.notice(
    'info',
    settingsNotice(
      previous === undefined
        ? `Before, ${name} had no URL.`
        : `To go back, change it to ${show(previous)} again${hidden ? ', with the credentials Lanefold does not show' : ''}.`,
    ),
  );
  return title;
}

/**
 * The commands as the webview may see them: credentials written into URLs hidden (git still gets
 * them as written). Undefined when there was nothing to hide.
 */
export function withoutCredentials(commands: readonly PlannedCommand[]): PlannedCommand[] | undefined {
  let hidden = false;
  const hide = (args: readonly string[]) => {
    const shown = args.map(redactCredentials);
    if (shown.some((arg, index) => arg !== args[index])) hidden = true;
    return shown;
  };
  const shown = commands.map((command) => ({
    ...command,
    args: hide(command.args),
    ...(command.onFailure ? { onFailure: hide(command.onFailure) } : {}),
    ...(command.fallback ? { fallback: hide(command.fallback) } : {}),
  }));
  return hidden ? shown : undefined;
}

/** How many branches a remote has here (not counting those of a remote nested in its name). */
async function branchesOf(repo: Repository, remote: string): Promise<number> {
  const [refs, remotes] = await Promise.all([
    repo.git(['for-each-ref', '--format=%(refname)%00%(symref)', `refs/remotes/${remote}/`], {
      readOnly: true,
      background: true,
      label: 'Remote branches',
    }),
    readConfiguredRemotes(repo),
  ]);
  const nested = remotes
    .filter((other) => other.name !== remote && other.name.startsWith(`${remote}/`))
    .map((other) => `refs/remotes/${other.name}/`);
  return refs.stdout.split('\n').filter((line) => {
    const [ref, symref] = line.split('\0');
    return !!ref && !symref && !nested.some((prefix) => ref.startsWith(prefix));
  }).length;
}

/**
 * The result of a remote operation that ran: what it did, in words (git says little), or why it
 * failed (`failure`: git's error, described).
 */
export async function remoteResult(
  repo: Repository,
  operation: RemoteOperation,
  title: string,
  failure?: { readonly message: string; readonly kind?: string },
): Promise<OperationResult> {
  if (failure) {
    // Adding and fetching are two steps: the remote is there although the fetch failed.
    const added =
      operation.kind === 'addRemote' &&
      operation.fetch === true &&
      (await readConfiguredRemotes(repo).catch(() => [])).some(
        (remote) => remote.name === text(operation.name).trim(),
      );
    return {
      status: 'failed',
      title,
      message: added
        ? `The remote was added, but fetching from it failed: ${failure.message}`
        : failure.message,
      errorKind: failure.kind,
    };
  }
  let message: string;
  switch (operation.kind) {
    case 'addRemote': {
      const name = text(operation.name).trim();
      if (operation.fetch !== true) message = `Fetch ${name} to see its branches.`;
      else {
        const count = await branchesOf(repo, name).catch(() => 0);
        message = count > 0 ? `Fetched ${remoteBranches(count)}.` : 'It has no branches yet.';
      }
      break;
    }
    case 'renameRemote':
      message = 'Its remote branches and the upstreams that named it follow.';
      break;
    case 'removeRemote':
      message = 'Its remote branches and the upstreams that named it are gone.';
      break;
    case 'setRemoteUrl':
      message = `${operation.push === true ? 'Pushes go to' : 'It fetches from'} ${redactCredentials(text(operation.url).trim())} now.`;
      break;
  }
  return { status: 'done', title, message };
}
