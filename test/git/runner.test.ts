import { afterEach, describe, expect, it } from 'vitest';
import { GitError } from '../../src/core/git/errors';
import type { GitCommandEnd, GitCommandStart } from '../../src/core/git/runner';
import { TestRepo } from '../fixtures/repoBuilder';

describe('GitRunner (real git)', () => {
  let repo: TestRepo | undefined;
  afterEach(async () => {
    await repo?.dispose();
    repo = undefined;
  });

  it('runs commands and reports them to the listener', async () => {
    const started: GitCommandStart[] = [];
    const ended: GitCommandEnd[] = [];
    repo = await TestRepo.create({
      runnerOptions: {
        listener: { onCommandStart: (e) => started.push(e), onCommandEnd: (e) => ended.push(e) },
      },
    });
    await repo.commit('first');
    const out = await repo.runner.run({
      cwd: repo.path,
      args: ['log', '--format=%s'],
      label: 'Read log',
      readOnly: true,
    });
    expect(out.stdout.trim()).toBe('first');
    expect(out.exitCode).toBe(0);
    const logStart = started.find((e) => e.label === 'Read log');
    expect(logStart?.readOnly).toBe(true);
    const logEnd = ended.find((e) => e.id === logStart?.id);
    expect(logEnd?.exitCode).toBe(0);
    expect(logEnd?.durationMs).toBeGreaterThanOrEqual(0);
    // Read-only commands do not keep stdout for the console.
    expect(logEnd?.stdoutTail).toBe('');
  });

  it('never reports credentials written into URLs, in the command or its errors', async () => {
    const started: GitCommandStart[] = [];
    const ended: GitCommandEnd[] = [];
    repo = await TestRepo.create({
      runnerOptions: {
        listener: { onCommandStart: (e) => started.push(e), onCommandEnd: (e) => ended.push(e) },
      },
    });
    const url = 'https://ann:s3cret-token@example.invalid/x.git';
    await repo.runner.run({ cwd: repo.path, args: ['remote', 'add', 'origin', url], label: 'Add' });
    const error = await repo.runner
      .run({ cwd: repo.path, args: ['remote', 'add', 'origin', url], label: 'Add again' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitError);
    const seen = JSON.stringify([started, ended, (error as GitError).message, (error as GitError).args]);
    expect(seen).not.toContain('s3cret');
    expect(seen).toContain('https://***@example.invalid/x.git');
    // git itself still gets the real URL.
    expect((await repo.git('remote', 'get-url', 'origin')).trim()).toBe(url);
  });

  it('produces deterministic hashes for identical fixture histories', async () => {
    repo = await TestRepo.create();
    const [a, b] = await repo.commits('one', 'two');
    const other = await TestRepo.create();
    try {
      const [c, d] = await other.commits('one', 'two');
      expect([c, d]).toEqual([a, b]);
    } finally {
      await other.dispose();
    }
  });

  it('throws a classified GitError on failure', async () => {
    repo = await TestRepo.create();
    await repo.commit('base', { files: { 'a.txt': 'one\n' } });
    await repo.checkoutNew('topic');
    await repo.commit('topic change', { files: { 'a.txt': 'two\n' } });
    await repo.checkout('main');
    await repo.write('a.txt', 'local edit\n');
    const error = await repo.runner
      .run({ cwd: repo.path, args: ['checkout', 'topic'] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).kind).toBe('dirtyWorkTree');
    expect((error as GitError).files).toEqual(['a.txt']);
  });

  it('accepts custom success exit codes', async () => {
    repo = await TestRepo.create();
    await repo.commit('base');
    const result = await repo.runner.run({
      cwd: repo.path,
      args: ['diff', '--quiet', 'HEAD', 'HEAD~0'],
      okExitCodes: [0, 1],
    });
    expect(result.exitCode).toBe(0);
  });

  it('streams stdout chunks', async () => {
    repo = await TestRepo.create();
    await repo.commits('a', 'b', 'c');
    const chunks: Buffer[] = [];
    await repo.runner.stream({ cwd: repo.path, args: ['log', '--format=%s'], readOnly: true }, (c) =>
      chunks.push(c),
    );
    expect(Buffer.concat(chunks).toString('utf8').trim().split('\n')).toEqual(['c', 'b', 'a']);
  });

  it('feeds stdin', async () => {
    repo = await TestRepo.create();
    const result = await repo.runner.run({
      cwd: repo.path,
      args: ['hash-object', '--stdin'],
      stdin: 'hello\n',
    });
    expect(result.stdout.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('can be cancelled', async () => {
    repo = await TestRepo.create();
    const controller = new AbortController();
    const pending = repo.runner.run({
      cwd: repo.path,
      args: ['-c', 'alias.slow=!sleep 10', 'slow'],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const error = await pending.catch((e: unknown) => e);
    expect((error as GitError).kind).toBe('cancelled');
  });

  it('never lets the caller environment redirect git', async () => {
    repo = await TestRepo.create();
    await repo.commit('first');
    const env = repo.runner.buildEnv({ env: {} });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_EDITOR).toBe('true');
    process.env.GIT_DIR = '/definitely/not/here';
    try {
      const result = await repo.runner.run({ cwd: repo.path, args: ['rev-parse', '--is-inside-work-tree'] });
      expect(result.stdout.trim()).toBe('true');
    } finally {
      delete process.env.GIT_DIR;
    }
  });
});
