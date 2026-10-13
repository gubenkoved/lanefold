import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RepoOperations } from '../../src/core/ops/operations';
import { RepoData } from '../../src/core/repo/repoData';
import { Repository } from '../../src/core/repo/repository';
import type { OperationResult } from '../../src/shared/operations';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { TestRepo } from '../fixtures/repoBuilder';

describe('what fetch, pull and push did (real git)', () => {
  let remote: TestRepo;
  let local: TestRepo;
  let otherDir: string;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];

  /** Another developer's clone, for changes made "elsewhere". */
  const other = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', join(otherDir, 'clone'), '-c', 'user.name=Bob', '-c', 'user.email=bob@x', ...args],
      { encoding: 'utf8', env: { ...process.env, ...local.env } },
    ).trim();

  /** A commit pushed from the other clone (to `branch`, default main; a new one starts at main). */
  function pushFromElsewhere(message: string, branch = 'main'): string {
    other('fetch', '-q', 'origin');
    const start = other('branch', '-r', '--list', `origin/${branch}`) ? `origin/${branch}` : 'origin/main';
    other('checkout', '-q', '-B', branch, start);
    execFileSync('sh', ['-c', `echo "${message}" >> "${join(otherDir, 'clone', 'elsewhere.txt')}"`]);
    other('add', 'elsewhere.txt');
    other('commit', '-qm', message);
    other('push', '-q', 'origin', branch);
    return other('rev-parse', 'HEAD');
  }

  beforeEach(async () => {
    remote = await TestRepo.create({ bare: true });
    local = await TestRepo.create();
    await local.commits('one', 'two');
    await local.addRemote('origin', remote);
    await local.git('push', '-q', '-u', 'origin', 'main');
    await local.git('push', '-q', 'origin', 'main:refs/heads/old');
    otherDir = await mkdtemp(join(tmpdir(), 'lanefold-other-'));
    execFileSync('git', ['clone', '-q', remote.path, join(otherDir, 'clone')], {
      env: { ...process.env, ...local.env },
    });
    ({ run, dispose } = await openOps(local));
  });

  afterEach(async () => {
    await dispose();
    await remote.dispose();
    await rm(otherDir, { recursive: true, force: true });
  });

  it('a fetch says which remote branches came, moved or went, and the new commits and tags', async () => {
    expect((await run({ kind: 'fetch' })).message).toBe('origin is up to date.');
    pushFromElsewhere('their change');
    pushFromElsewhere('a branch of theirs', 'theirs');
    other('push', '-q', 'origin', '--delete', 'old');
    other('tag', 'v1', 'origin/main');
    other('push', '-q', 'origin', 'v1');
    const result = await run({ kind: 'fetch', prune: true });
    expect(result).toMatchObject({
      status: 'done',
      message: 'Fetched origin: 1 new branch, 1 updated, 1 removed (2 new commits). 1 new tag.',
    });
    expect(result.entry).toBeUndefined();
  });

  it('fetching every remote names those that changed; an empty remote has no branches yet', async () => {
    const empty = await TestRepo.create({ bare: true });
    try {
      await local.addRemote('empty', empty);
      expect((await run({ kind: 'fetch', remote: 'empty' })).message).toBe('empty has no branches yet.');
      expect((await run({ kind: 'fetch' })).message).toBe('Every remote is up to date.');
      pushFromElsewhere('news');
      expect((await run({ kind: 'fetch' })).message).toBe('Fetched origin: 1 branch updated (1 new commit).');
    } finally {
      await empty.dispose();
    }
  });

  it('a push says where it went and how many commits; a force push what it took off', async () => {
    await local.commits('three', 'four');
    expect((await run({ kind: 'push' })).message).toBe('Pushed main to origin (2 commits).');

    await local.checkoutNew('topic');
    await local.commit('topic work');
    expect((await run({ kind: 'push' })).message).toBe('Published topic to origin (1 commit).');

    await local.checkout('main');
    await local.git('reset', '-q', '--hard', 'HEAD~1');
    await local.commit('rewritten');
    const forced = await run({ kind: 'push', force: true });
    expect(forced.message).toBe(
      'Replaced origin/main with main: 1 commit pushed, 1 commit taken off the remote.',
    );
  });

  it('a pull says what it brought in, and how', async () => {
    expect((await run({ kind: 'pull', mode: 'ff-only' })).message).toBe(
      'main is up to date with origin/main.',
    );
    pushFromElsewhere('incoming');
    expect((await run({ kind: 'pull', mode: 'ff-only' })).message).toBe(
      'Fast-forwarded main by 1 commit from origin/main.',
    );

    pushFromElsewhere('incoming again');
    await local.commit('mine', { files: { 'mine.txt': 'mine\n' } });
    const merged = await run({ kind: 'pull', mode: 'merge' });
    expect(merged.message).toBe('Merged 1 commit from origin/main into main.');
    expect(merged.entry).toBeDefined();

    await local.git('push', '-q', 'origin', 'main');
    pushFromElsewhere('and again');
    await local.commit('mine too', { files: { 'mine2.txt': 'mine\n' } });
    expect((await run({ kind: 'pull', mode: 'rebase' })).message).toBe(
      'Rebased 1 local commit of main onto 1 new commit from origin/main.',
    );
  });

  it('pushing and deleting a tag on the remote say so', async () => {
    await local.git('tag', 'v1');
    expect((await run({ kind: 'pushTag', name: 'v1' })).message).toBe('v1 is on origin now.');
    expect((await run({ kind: 'deleteRemoteTag', name: 'v1', remote: 'origin' })).message).toBe(
      'v1 is gone from origin; your local tag stays.',
    );
  });

  it('fetching every remote names one it could not reach, and says what the others brought', async () => {
    await local.git('remote', 'add', 'gone', join(otherDir, 'nowhere.git'));
    pushFromElsewhere('news');
    const result = await run({ kind: 'fetch' });
    expect(result).toMatchObject({
      status: 'failed',
      message:
        'Could not fetch gone (no git repository there). Fetched origin: 1 branch updated (1 new commit).',
    });
  });

  it('a remote that is not there says so plainly', async () => {
    await local.git('remote', 'add', 'gone', join(otherDir, 'nowhere.git'));
    const result = await run({ kind: 'fetch', remote: 'gone' });
    expect(result).toMatchObject({
      status: 'failed',
      message: `There is no git repository at ${join(otherDir, 'nowhere.git')}.`,
    });
  });
});

describe('signing in to a remote (real git, a local server)', () => {
  let server: Server;
  let test: TestRepo;
  let scripts: string;

  beforeEach(async () => {
    // A server that wants credentials for everything, and refuses them all.
    server = createServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="lanefold"' }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    scripts = await mkdtemp(join(tmpdir(), 'lanefold-askpass-'));
    for (const [name, body] of [
      ['cancel.sh', 'exit 1'],
      ['answer.sh', 'echo someone'],
    ]) {
      await writeFile(join(scripts, name!), `#!/bin/sh\n${body}\n`);
      await chmod(join(scripts, name!), 0o755);
    }
  });

  afterEach(async () => {
    server.close();
    await test?.dispose();
    await rm(scripts, { recursive: true, force: true });
  });

  async function fetchWith(askpass: string): Promise<OperationResult> {
    test = await TestRepo.create({ runnerOptions: { env: { GIT_ASKPASS: join(scripts, askpass) } } });
    await test.commit('one');
    const { port } = server.address() as AddressInfo;
    await test.git('remote', 'add', 'origin', `http://127.0.0.1:${port}/app.git`);
    const repo = (await Repository.open(test.runner, test.path))!;
    const data = new RepoData(repo);
    const ops = new RepoOperations(repo, data);
    try {
      return await ops.execute((await ops.plan({ kind: 'fetch' })).id);
    } finally {
      ops.dispose();
      data.dispose();
    }
  }

  it('a cancelled prompt is said to be cancelled (not the helper’s path)', async () => {
    const result = await fetchWith('cancel.sh');
    expect(result).toMatchObject({
      status: 'failed',
      message: 'Signing in to 127.0.0.1 was cancelled.',
    });
  });

  it('refused credentials are said to be refused', async () => {
    const result = await fetchWith('answer.sh');
    expect(result).toMatchObject({
      status: 'failed',
      message: 'Signing in to 127.0.0.1 failed: the user name and password (or token) were not accepted.',
    });
  });
});
