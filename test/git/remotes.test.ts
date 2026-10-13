import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitCommandEnd, GitCommandStart } from '../../src/core/git/runner';
import type { RepoOperations } from '../../src/core/ops/operations';
import { readRemotes } from '../../src/core/repo/remotes';
import type { Repository } from '../../src/core/repo/repository';
import type { Operation, OperationPlan } from '../../src/shared/operations';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

const SECRET_URL = 'https://ann:s3cret-token@example.invalid/team/app.git';

describe('remotes (real git)', () => {
  let origin: TestRepo;
  let mirror: TestRepo;
  let local: TestRepo;
  let repo: Repository;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];
  /** Everything the Git Console and the output channel were told. */
  let logged: (GitCommandStart | GitCommandEnd)[];

  beforeEach(async () => {
    origin = await TestRepo.create({ bare: true });
    mirror = await TestRepo.create({ bare: true });
    logged = [];
    local = await TestRepo.create({
      runnerOptions: {
        listener: { onCommandStart: (e) => logged.push(e), onCommandEnd: (e) => logged.push(e) },
      },
    });
    await local.commits('one', 'two');
    await local.addRemote('origin', origin);
    await local.git('push', '-q', '-u', 'origin', 'main');
    await local.checkoutNew('topic');
    await local.commit('topic work');
    await local.git('push', '-q', '-u', 'origin', 'topic');
    await local.checkout('main');
    // The mirror has a branch of its own.
    await local.git('push', '-q', mirror.path, 'main:refs/heads/elsewhere');
    ({ repo, ops, run, dispose } = await openOps(local));
  });

  afterEach(async () => {
    await dispose();
    await origin.dispose();
    await mirror.dispose();
  });

  const said = (plan: OperationPlan, level?: string) =>
    plan.notices
      .filter((notice) => !level || notice.level === level)
      .map((notice) => notice.text)
      .join('\n');

  async function blocked(operation: Operation, reason: RegExp): Promise<void> {
    const plan = await ops.plan(operation);
    expect(plan.blocked).toBe(true);
    expect(said(plan, 'danger')).toMatch(reason);
    expect(await ops.execute(plan.id)).toMatchObject({ status: 'refused' });
  }

  const upstreamOf = (branch: string) =>
    local.git('for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`);

  it('lists every remote, fetched or not, with credentials hidden', async () => {
    await local.git('remote', 'add', 'team', SECRET_URL);
    await local.git('remote', 'set-url', '--push', 'origin', mirror.path);
    const remotes = await readRemotes(repo);
    expect(remotes).toEqual([
      { name: 'origin', url: origin.path, pushUrl: mirror.path },
      { name: 'team', url: 'https://***@example.invalid/team/app.git', credentialsHidden: true },
    ]);
    expect(JSON.stringify(remotes)).not.toContain('s3cret');
    // The URLs were read, not reported.
    expect(JSON.stringify(logged)).not.toContain('s3cret');
  });

  it('adds a remote and fetches it: its branches arrive, and nothing is journaled', async () => {
    const plan = await ops.plan({ kind: 'addRemote', name: 'mirror', url: mirror.path, fetch: true });
    expect(plan.title).toBe('Add remote mirror');
    expect(plan.commands.map((command) => command.args)).toEqual([
      ['remote', 'add', '--', 'mirror', mirror.path],
      ['fetch', 'mirror'],
    ]);
    expect(said(plan)).toMatch(/Undo cannot take it back\. Removing mirror does\./);
    const result = await ops.execute(plan.id);
    expect(result).toMatchObject({ status: 'done', message: 'Fetched 1 remote branch.' });
    expect(await local.git('remote')).toBe('mirror\norigin');
    expect(await local.git('branch', '-r', '--list', 'mirror/*')).toBe('  mirror/elsewhere');
    expect(result.entry).toBeUndefined();
    expect(ops.undoInfo.undo).toBeUndefined();
  });

  it('adds a remote without fetching it: it is listed all the same', async () => {
    const result = await run({ kind: 'addRemote', name: 'mirror', url: mirror.path });
    expect(result).toMatchObject({ status: 'done', message: 'Fetch mirror to see its branches.' });
    expect((await readRemotes(repo)).map((remote) => remote.name)).toEqual(['mirror', 'origin']);
    expect(await local.git('branch', '-r', '--list', 'mirror/*')).toBe('');
  });

  it('refuses names and URLs git could misread, taken or invalid names', async () => {
    const add = (name: string, url = mirror.path): Operation => ({ kind: 'addRemote', name, url });
    await blocked(add('origin'), /There is already a remote named origin\./);
    await blocked(add('-x'), /cannot start with “-”/);
    await blocked(add('my fork'), /cannot contain spaces/);
    await blocked(add('a..b'), /A remote name cannot contain “\.\.”/);
    await blocked(add('team:ci'), /forbidden character/);
    await blocked(add(''), /Enter a name/);
    await blocked(add('mirror', '--upload-pack=touch /tmp/lanefold-pwned'), /A URL cannot start with “-”/);
    await blocked(add('mirror', ' -oProxyCommand=x'), /A URL cannot start with “-”/);
    await blocked(add('mirror', ''), /Enter the URL/);
    await blocked(add('mirror', `${mirror.path}\nfetch = x`), /control characters/);
    // A malformed request is no URL either.
    await blocked({ kind: 'addRemote', name: 'mirror', url: 42 } as unknown as Operation, /Enter the URL/);
    expect(await local.git('remote')).toBe('origin');
  });

  it('keeps credentials out of the plan, the console and the result; git gets them', async () => {
    // What a plan shows: everything but the operation, which is what the webview sent.
    const shown = (plan: OperationPlan) => JSON.stringify({ ...plan, operation: undefined });
    const plan = await ops.plan({ kind: 'addRemote', name: 'team', url: SECRET_URL });
    expect(plan.commands[0]!.args).toEqual([
      'remote',
      'add',
      '--',
      'team',
      'https://***@example.invalid/team/app.git',
    ]);
    expect(said(plan, 'warning')).toMatch(/holds a password or token/);
    expect(shown(plan)).not.toContain('s3cret');
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await local.git('remote', 'get-url', 'team')).toBe(SECRET_URL);

    const change = await ops.plan({
      kind: 'setRemoteUrl',
      name: 'team',
      url: SECRET_URL.replace('app', 'api'),
    });
    expect(said(change)).toMatch(
      /change it to https:\/\/\*\*\*@example\.invalid\/team\/app\.git again, with the credentials/,
    );
    expect(shown(change)).not.toContain('s3cret');
    const result = await ops.execute(change.id);
    expect(result.message).toBe('It fetches from https://***@example.invalid/team/api.git now.');
    expect(await local.git('remote', 'get-url', 'team')).toBe(SECRET_URL.replace('app', 'api'));

    const removal = await ops.plan({ kind: 'removeRemote', name: 'team' });
    expect(JSON.stringify(removal)).not.toContain('s3cret');
    expect(JSON.stringify(logged)).not.toContain('s3cret');
  });

  it('renames a remote: its remote branches and the upstreams of branches tracking it follow', async () => {
    const plan = await ops.plan({ kind: 'renameRemote', from: 'origin', to: 'upstream' });
    expect(plan.title).toBe('Rename remote origin to upstream');
    expect(plan.commands.map((command) => command.args)).toEqual([
      ['remote', 'rename', 'origin', 'upstream'],
    ]);
    expect(said(plan)).toContain('Its remote branches become upstream/main and upstream/topic.');
    expect(said(plan)).toContain(
      'main and topic keep tracking it (as upstream/main and upstream/topic): pull and push go on working.',
    );
    const result = await ops.execute(plan.id);
    expect(result.status).toBe('done');
    expect(await local.git('remote')).toBe('upstream');
    expect(await local.git('branch', '-r')).toBe('  upstream/main\n  upstream/topic');
    expect(await upstreamOf('main')).toBe('upstream/main');
    expect(await upstreamOf('topic')).toBe('upstream/topic');
    expect(ops.undoInfo.undo).toBeUndefined();
    // Pull and push go on working with the new name.
    expect((await ops.plan({ kind: 'pull', mode: 'ff-only' })).commands[0]!.args).toEqual([
      'pull',
      '--ff-only',
      '--no-rebase',
      'upstream',
      'main',
    ]);
  });

  it('refuses renaming to a taken, the same or an invalid name, and renaming an unknown remote', async () => {
    await local.git('remote', 'add', 'mirror', mirror.path);
    const rename = (from: string, to: string): Operation => ({ kind: 'renameRemote', from, to });
    await blocked(rename('origin', 'mirror'), /There is already a remote named mirror\./);
    await blocked(rename('origin', 'origin'), /Enter a new name for origin\./);
    await blocked(rename('origin', '-x'), /cannot start with “-”/);
    await blocked(rename('origin', 'up stream'), /cannot contain spaces/);
    await blocked(rename('nope', 'other'), /There is no remote named nope\./);
    expect(await local.git('remote')).toBe('mirror\norigin');
  });

  it('removes a remote after listing its remote branches and the upstreams it clears', async () => {
    // A commit that only origin/gone has.
    await local.checkoutNew('gone');
    await local.commit('only on the remote');
    await local.git('push', '-q', 'origin', 'gone');
    await local.checkout('main');
    await local.git('branch', '-q', '-D', 'gone');
    await run({ kind: 'fetch' });

    const plan = await ops.plan({ kind: 'removeRemote', name: 'origin' });
    expect(plan.destructive).toBe(true);
    expect(plan.commands.map((command) => command.args)).toEqual([['remote', 'remove', 'origin']]);
    expect(said(plan, 'danger')).toMatch(
      /Its 3 remote branches are deleted here: origin\/gone, origin\/main and origin\/topic\. 1 commit is only on them, so no branch here keeps it\. Undo cannot bring them back: to get them back, add it again \(.+\) and fetch\./,
    );
    expect(said(plan, 'warning')).toBe(
      'main and topic lose their upstream (origin/main, origin/topic): pull needs one again, and the next push sets one.',
    );
    const result = await ops.execute(plan.id);
    expect(result.status).toBe('done');
    expect(await local.git('remote')).toBe('');
    expect(await local.git('branch', '-r')).toBe('');
    expect(await upstreamOf('main')).toBe('');
    expect(await upstreamOf('topic')).toBe('');
    expect(ops.undoInfo.undo).toBeUndefined();

    await blocked({ kind: 'removeRemote', name: 'origin' }, /There is no remote named origin\./);
  });

  it('removes a remote that was never fetched', async () => {
    await local.git('remote', 'add', 'mirror', mirror.path);
    const plan = await ops.plan({ kind: 'removeRemote', name: 'mirror' });
    expect(said(plan, 'danger')).toBe('');
    expect(said(plan)).toMatch(/to undo, add it again \(.+\) and fetch\./);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await local.git('remote')).toBe('origin');
  });

  it('changes the URL, or only where pushes go', async () => {
    const plan = await ops.plan({ kind: 'setRemoteUrl', name: 'origin', url: mirror.path });
    expect(plan.commands[0]!.args).toEqual(['remote', 'set-url', '--', 'origin', mirror.path]);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await local.git('remote', 'get-url', 'origin')).toBe(mirror.path);
    expect(await local.git('remote', 'get-url', '--push', 'origin')).toBe(mirror.path);

    const push = await ops.plan({ kind: 'setRemoteUrl', name: 'origin', url: origin.path, push: true });
    expect(push.title).toBe('Change the push URL of origin');
    expect(push.commands[0]!.args).toEqual(['remote', 'set-url', '--push', '--', 'origin', origin.path]);
    expect(said(push)).toMatch(/Fetching keeps using /);
    expect((await ops.execute(push.id)).status).toBe('done');
    expect(await local.git('remote', 'get-url', 'origin')).toBe(mirror.path);
    expect(await local.git('remote', 'get-url', '--push', 'origin')).toBe(origin.path);
    expect(await readRemotes(repo)).toEqual([{ name: 'origin', url: mirror.path, pushUrl: origin.path }]);
    expect(ops.undoInfo.undo).toBeUndefined();
  });

  it('refuses a URL change that changes nothing, could be misread, or names no remote', async () => {
    const setUrl = (url: string, push?: boolean, name = 'origin'): Operation => ({
      kind: 'setRemoteUrl',
      name,
      url,
      push,
    });
    await blocked(setUrl(origin.path), /origin already fetches from there\./);
    await blocked(setUrl(origin.path, true), /Pushes to origin already go there\./);
    await blocked(setUrl('-x'), /A URL cannot start with “-”/);
    await blocked(setUrl(mirror.path, false, 'nope'), /There is no remote named nope\./);
    await local.git('remote', 'set-url', '--add', 'origin', mirror.path);
    await blocked(setUrl('/elsewhere.git'), /origin has 2 URLs/);
  });

  it('says the remote was added when fetching from it then fails', async () => {
    const plan = await ops.plan({
      kind: 'addRemote',
      name: 'broken',
      url: `${mirror.path}-missing`,
      fetch: true,
    });
    const result = await ops.execute(plan.id);
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/^The remote was added, but fetching from it failed: /);
    expect(await local.git('remote')).toBe('broken\norigin');
  });

  it('blocks pushing and fetching without a remote, offering to add one', async () => {
    await local.git('remote', 'remove', 'origin');
    const push = await ops.plan({ kind: 'push' });
    expect(push).toMatchObject({ blocked: true, needsRemote: true });
    expect(said(push, 'danger')).toBe('This repository has no remote to push to. Add one first.');
    expect(await ops.plan({ kind: 'fetch' })).toMatchObject({ blocked: true, needsRemote: true });
    // With a remote, nothing of the kind.
    await run({ kind: 'addRemote', name: 'origin', url: origin.path, fetch: true });
    expect((await ops.plan({ kind: 'push' })).needsRemote).toBeUndefined();
  });
});
