import { request as httpRequest, type ClientRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRunner } from '../../src/core/git/runner';
import { AskpassServer, askpassKind } from '../../src/core/ipc/askpass';
import type { RepoOperations } from '../../src/core/ops/operations';
import { openOps, type OpsHarness } from '../fixtures/opsHarness';
import { BOB, TestRepo, testGitBinary } from '../fixtures/repoBuilder';

describe('fetch, pull and push (real git)', () => {
  let remote: TestRepo;
  let local: TestRepo;
  let otherDir: string;
  let ops: RepoOperations;
  let run: OpsHarness['run'];
  let dispose: OpsHarness['dispose'];

  /** Another developer's clone, for pushing from "elsewhere". */
  const other = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', join(otherDir, 'clone'), '-c', 'user.name=Bob', '-c', 'user.email=bob@x', ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, ...local.env },
      },
    ).trim();

  beforeEach(async () => {
    remote = await TestRepo.create({ bare: true });
    local = await TestRepo.create();
    await local.commits('one', 'two');
    await local.addRemote('origin', remote);
    await local.git('push', '-q', '-u', 'origin', 'main');
    otherDir = await mkdtemp(join(tmpdir(), 'lanefold-other-'));
    execFileSync('git', ['clone', '-q', remote.path, join(otherDir, 'clone')], {
      env: { ...process.env, ...local.env },
    });
    ({ ops, run, dispose } = await openOps(local));
  });

  afterEach(async () => {
    await dispose();
    await remote.dispose();
    await rm(otherDir, { recursive: true, force: true });
  });

  /** Another commit pushed to origin/main from the other clone. */
  function pushFromElsewhere(message: string, file = 'elsewhere.txt'): string {
    execFileSync('sh', ['-c', `echo "${message}" >> "${join(otherDir, 'clone', file)}"`]);
    other('add', file);
    other('commit', '-qm', message);
    other('push', '-q', 'origin', 'main');
    return other('rev-parse', 'HEAD');
  }

  it('publishes a new branch and sets its upstream; pushes are not undoable', async () => {
    await local.checkoutNew('topic');
    await local.commit('topic work');
    const plan = await ops.plan({ kind: 'push' });
    expect(plan.commands[0]!.args).toEqual(['push', '--set-upstream', 'origin', 'topic']);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await remote.git('rev-parse', 'topic')).toBe(await local.rev('topic'));
    expect(await local.git('rev-parse', '--abbrev-ref', 'topic@{upstream}')).toBe('origin/topic');
    expect(ops.undoInfo.undo).toBeUndefined();
  });

  it('refuses a push the remote would reject, and force-pushes with a lease', async () => {
    const theirs = pushFromElsewhere('their change');
    await local.commit('my change');
    await run({ kind: 'fetch' });
    const refused = await ops.plan({ kind: 'push' });
    expect(refused.blocked).toBe(true);
    expect(refused.notices[0]!.text).toMatch(/has 1 commit that main lacks/);

    const forced = await ops.plan({ kind: 'push', force: true });
    expect(forced.blocked).toBeFalsy();
    expect(forced.destructive).toBe(true);
    expect(forced.commands[0]!.args).toEqual([
      'push',
      `--force-with-lease=refs/heads/main:${theirs}`,
      'origin',
      'main',
    ]);
    // Their commit came with a fetch and was never in main: the plan says so.
    expect(forced.notices.map((n) => n.text).join('\n')).toMatch(/never was in your main/);
    expect((await ops.execute(forced.id)).status).toBe('done');
    expect(await remote.git('rev-parse', 'main')).toBe(await local.rev('main'));
  });

  it('a force push fails safely when the remote moved since the last fetch', async () => {
    pushFromElsewhere('first');
    await local.commit('mine');
    await run({ kind: 'fetch' });
    const forced = await ops.plan({ kind: 'push', force: true });
    const newest = pushFromElsewhere('pushed while I was looking');
    const result = await ops.execute(forced.id);
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/changed since your last fetch/);
    expect(await remote.git('rev-parse', 'main')).toBe(newest);
  });

  it('pulls fast-forward, and Undo goes back', async () => {
    const before = await local.rev('main');
    const theirs = pushFromElsewhere('incoming');
    const plan = await ops.plan({ kind: 'pull', mode: 'ff-only' });
    expect(plan.commands[0]!.args).toEqual(['pull', '--ff-only', '--no-rebase', 'origin', 'main']);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await local.rev('main')).toBe(theirs);
    expect((await ops.undo()).status).toBe('done');
    expect(await local.rev('main')).toBe(before);
  });

  it('pulls with rebase over local commits', async () => {
    pushFromElsewhere('incoming', 'theirs.txt');
    await local.commit('local work', { author: BOB });
    await run({ kind: 'fetch' });
    const plan = await ops.plan({ kind: 'pull', mode: 'rebase' });
    expect(plan.destructive).toBe(true);
    expect((await ops.execute(plan.id)).status).toBe('done');
    expect(await local.log('main', '%s')).toEqual(['local work', 'incoming', 'two', 'one']);
    expect(await local.git('rev-parse', 'HEAD~1')).toBe(await local.git('rev-parse', 'origin/main'));
  });

  it('pushes one tag or all tags, and deletes a tag from the remote (keeping it locally)', async () => {
    await local.git('tag', 'v1');
    await local.git('tag', '-a', 'v2', '-m', 'Version 2');
    const one = await ops.plan({ kind: 'pushTag', name: 'v1' });
    expect(one.commands[0]!.args).toEqual(['push', 'origin', 'refs/tags/v1']);
    expect((await ops.execute(one.id)).status).toBe('done');
    expect(await remote.git('tag', '--list')).toBe('v1');

    await run({ kind: 'pushTag' });
    expect((await remote.git('tag', '--list')).split('\n')).toEqual(['v1', 'v2']);

    const remove = await ops.plan({ kind: 'deleteRemoteTag', name: 'v1', remote: 'origin' });
    expect(remove.destructive).toBe(true);
    expect(remove.commands[0]!.args).toEqual(['push', 'origin', '--delete', 'refs/tags/v1']);
    await ops.execute(remove.id);
    expect(await remote.git('tag', '--list')).toBe('v2');
    expect(await local.git('tag', '--list')).toBe('v1\nv2');
    expect(ops.undoInfo.undo).toBeUndefined();

    expect((await ops.plan({ kind: 'pushTag', name: 'nope' })).blocked).toBe(true);
  });

  it('fetch --prune forgets remote branches deleted on the remote', async () => {
    other('push', '-q', 'origin', 'HEAD:refs/heads/short-lived');
    await run({ kind: 'fetch' });
    expect(await local.git('branch', '-r')).toContain('origin/short-lived');
    other('push', '-q', 'origin', '--delete', 'short-lived');
    const plan = await ops.plan({ kind: 'fetch', prune: true });
    expect(plan.commands[0]!.args).toEqual(['fetch', '--prune', 'origin']);
    await ops.execute(plan.id);
    expect(await local.git('branch', '-r')).not.toContain('short-lived');
  });
});

describe('credential prompts (askpass bridge)', () => {
  it('classifies prompts', () => {
    expect(askpassKind("Username for 'https://github.com': ")).toBe('username');
    expect(askpassKind("Password for 'https://alice@github.com': ")).toBe('password');
    expect(askpassKind("Enter passphrase for key '/home/a/.ssh/id_ed25519': ")).toBe('passphrase');
    expect(askpassKind('Are you sure you want to continue connecting (yes/no/[fingerprint])? ')).toBe(
      'confirm',
    );
  });

  it('answers git’s credential prompts through the helper script, and cancels cleanly', async () => {
    const prompts: string[] = [];
    let cancel = false;
    const server = await AskpassServer.start(async ({ prompt, kind }) => {
      prompts.push(prompt);
      if (cancel) return undefined;
      return kind === 'username' ? 'alice' : 's3cret';
    });
    const test = await TestRepo.create();
    try {
      const env = server.env(
        resolve('src/core/ipc/askpass.sh'),
        resolve('src/core/ipc/askpass-main.cjs'),
        process.execPath,
      );
      const runner = new GitRunner(await testGitBinary(), { env: { ...test.env, ...env } });
      const fill = (okExitCodes?: number[]) =>
        runner.run({
          cwd: test.path,
          args: ['credential', 'fill'],
          stdin: 'protocol=https\nhost=example.com\n\n',
          okExitCodes,
        });
      const { stdout } = await fill();
      expect(stdout).toContain('username=alice');
      expect(stdout).toContain('password=s3cret');
      expect(prompts).toEqual([
        "Username for 'https://example.com': ",
        "Password for 'https://alice@example.com': ",
      ]);
      cancel = true;
      const cancelled = await fill([0, 128]);
      expect(cancelled.exitCode).toBe(128);
    } finally {
      server.dispose();
      await test.dispose();
    }
  });

  it('answers only processes that know its token, and drops a prompt whose asker went away', async () => {
    let aborted = false;
    const server = await AskpassServer.start(
      (_request, signal) =>
        new Promise((resolveAnswer) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolveAnswer(undefined);
          });
        }),
    );
    try {
      const post = (token: string | undefined) =>
        new Promise<{ status: number; request: ClientRequest }>((done, fail) => {
          const request = httpRequest(
            {
              socketPath: server.handle,
              path: '/',
              method: 'POST',
              headers: token ? { 'X-Lanefold-Token': token } : {},
            },
            (response) => done({ status: response.statusCode ?? 0, request }),
          );
          request.on('error', fail);
          request.end(JSON.stringify({ prompt: 'Password: ' }));
          if (token) setTimeout(() => request.destroy(), 100);
        });
      expect((await post(undefined)).status).toBe(403);
      expect((await post('not-the-token')).status).toBe(403);
      // With the token, the prompt waits for an answer; the client hanging up cancels it.
      const token = server.env('', '', '').LANEFOLD_ASKPASS_TOKEN!;
      await post(token).catch(() => undefined);
      await expect.poll(() => aborted).toBe(true);
    } finally {
      server.dispose();
    }
  });
});
