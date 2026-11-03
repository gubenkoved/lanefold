import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linesAt } from '../../src/core/blame/blame';
import { pushedCommit, readCodeHosts, remotesContaining } from '../../src/core/repo/codeHosts';
import { Repository } from '../../src/core/repo/repository';
import { DEFAULT_LINK_SETTINGS, readLinkSettings } from '../../src/shared/codeHosts';
import { TestRepo } from '../fixtures/repoBuilder';

describe('code hosts (real git)', () => {
  let origin: TestRepo;
  let local: TestRepo;
  let repo: Repository;
  let pushed: string;
  let unpushed: string;

  beforeEach(async () => {
    origin = await TestRepo.create({ bare: true });
    local = await TestRepo.create();
    await local.commit('First notes', { files: { 'notes.txt': 'one\ntwo\nthree\nfour\nfive\n' } });
    pushed = await local.commit('Second notes');
    await local.addRemote('origin', origin);
    await local.git('push', '-q', '-u', 'origin', 'main');
    unpushed = await local.commit('Not pushed');
    // Pushed while the remote was a folder; from now on it names a code host.
    await local.git('remote', 'set-url', 'origin', 'git@github.com:acme/aurora.git');
    repo = (await Repository.open(local.runner, local.path))!;
  });

  afterEach(async () => {
    await local.dispose();
    await origin.dispose();
  });

  it('reads the remotes on code hosts as git uses their URLs, the original repository first', async () => {
    await local.git('remote', 'add', 'upstream', 'gh:parent/aurora');
    await local.git('config', 'url.git@github.com:.insteadOf', 'gh:');
    await local.git('remote', 'add', 'work', 'git@github-work:team/app.git');
    await local.git('remote', 'add', 'folder', origin.path);
    await local.git('remote', 'add', 'mirror', 'https://git.example.com/mirror/aurora.git');
    const aliases: string[] = [];
    const lookUp = async (alias: string) => {
      aliases.push(alias);
      return alias === 'github-work' ? 'github.com' : undefined;
    };

    const hosts = await readCodeHosts(repo, DEFAULT_LINK_SETTINGS, lookUp);
    expect(hosts.map((host) => [host.remote, host.url])).toEqual([
      ['upstream', 'https://github.com/parent/aurora'],
      ['origin', 'https://github.com/acme/aurora'],
      ['work', 'https://github.com/team/app'],
    ]);
    // Only a host that is not known by name is looked up.
    expect(aliases).toEqual(['github-work']);

    const settings = readLinkSettings({ 'git.example.com': 'gitlab' }, []);
    expect((await readCodeHosts(repo, settings, lookUp)).map((host) => host.remote)).toContain('mirror');
  });

  it('finds the remotes that have a commit, names with slashes included', async () => {
    await local.git('remote', 'add', 'team/mirror', 'git@gitlab.com:team/aurora.git');
    await local.git('update-ref', 'refs/remotes/team/mirror/main', pushed);
    const remotes = ['origin', 'team', 'team/mirror'];
    expect(await remotesContaining(repo, pushed, remotes)).toEqual(new Set(['origin', 'team/mirror']));
    expect(await remotesContaining(repo, unpushed, remotes)).toEqual(new Set());
  });

  it('finds the newest commit of HEAD a remote has', async () => {
    expect(await pushedCommit(repo)).toBe(pushed);
    await local.git('push', '-q', origin.path, 'main:main');
    await local.git('fetch', '-q', origin.path, 'main:refs/remotes/origin/main');
    expect(await pushedCommit(repo)).toBe(unpushed);
    await local.git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(await pushedCommit(repo)).toBeUndefined();
  });

  it('maps lines of the working tree, or an editor, to a commit, and says when they changed', async () => {
    // Two lines added above, line "four" edited.
    await local.write('notes.txt', 'zero\nhalf\none\ntwo\nthree\nFOUR\nfive\n');
    expect(await linesAt(repo, pushed, 'notes.txt', 3, 4)).toEqual({ start: 1, end: 2, changed: false });
    expect(await linesAt(repo, pushed, 'notes.txt', 5, 6)).toEqual({ start: 3, end: 4, changed: true });
    // Unsaved contents of an editor rather than the file on disk.
    expect(
      await linesAt(repo, pushed, 'notes.txt', 2, 2, 'one\none and a half\ntwo\nthree\nfour\nfive\n'),
    ).toEqual({
      start: 1,
      end: 1,
      changed: true,
    });
  });
});
