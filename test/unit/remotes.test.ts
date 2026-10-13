import { describe, expect, it } from 'vitest';
import { withoutCredentials } from '../../src/core/ops/plans/remotes';
import {
  describeRemote,
  parseRemotes,
  remoteBranchesOf,
  validateRemoteName,
  validateRemoteUrl,
} from '../../src/core/repo/remotes';
import type { RefInfo } from '../../src/shared/models';

describe('parseRemotes', () => {
  it('reads each remote’s URLs, push URLs and fetch settings, in the order git lists them', () => {
    const config = [
      'remote.origin.url\nhttps://github.com/ann/app.git',
      'remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*',
      'remote.team.ci.url\n/srv/git/My Projects/app.git',
      'remote.team.ci.pushurl\ngit@example.com:team/app.git',
      'remote.team.ci.pushurl\nssh://git@backup.example.com/app.git',
      // A key without a value, and a remote git does not list: ignored.
      'remote.origin.url',
      'remote.ghost.url\n/nowhere',
      '',
    ].join('\0');
    expect(parseRemotes('team.ci\norigin\nbare\n', config)).toEqual([
      {
        name: 'team.ci',
        urls: ['/srv/git/My Projects/app.git'],
        pushUrls: ['git@example.com:team/app.git', 'ssh://git@backup.example.com/app.git'],
        fetch: [],
      },
      {
        name: 'origin',
        urls: ['https://github.com/ann/app.git'],
        pushUrls: [],
        fetch: ['+refs/heads/*:refs/remotes/origin/*'],
      },
      // Listed, but with no URL of its own.
      { name: 'bare', urls: [], pushUrls: [], fetch: [] },
    ]);
  });

  it('handles no remotes at all', () => {
    expect(parseRemotes('', '')).toEqual([]);
  });
});

describe('describeRemote', () => {
  const remote = (urls: string[], pushUrls: string[] = []) =>
    describeRemote({ name: 'origin', urls, pushUrls, fetch: [] });

  it('hides tokens and passwords written into URLs, never an ssh user name', () => {
    expect(remote(['https://ann:ghp_s3cret@github.com/ann/app.git'])).toEqual({
      name: 'origin',
      url: 'https://***@github.com/ann/app.git',
      credentialsHidden: true,
    });
    expect(remote(['https://ghp_s3cret@github.com/ann/app.git']).url).toBe(
      'https://***@github.com/ann/app.git',
    );
    expect(remote(['ssh://git@github.com/ann/app.git'])).toEqual({
      name: 'origin',
      url: 'ssh://git@github.com/ann/app.git',
    });
    expect(remote(['git@github.com:ann/app.git']).credentialsHidden).toBeUndefined();
  });

  it('names a push URL only when pushes go elsewhere, hiding its credentials too', () => {
    expect(remote(['/srv/app.git'], ['/srv/app.git']).pushUrl).toBeUndefined();
    expect(remote(['/srv/app.git'], ['https://bot:t0ken@example.com/app.git'])).toEqual({
      name: 'origin',
      url: '/srv/app.git',
      pushUrl: 'https://***@example.com/app.git',
      credentialsHidden: true,
    });
    // git fetches from the first URL.
    expect(remote(['/first.git', '/second.git']).url).toBe('/first.git');
    expect(remote([])).toEqual({ name: 'origin' });
  });
});

describe('validateRemoteName', () => {
  it.each(['origin', 'upstream', 'team/ci', 'ann.fork', 'Backup_2'])('accepts %s', (name) => {
    expect(validateRemoteName(name)).toBeUndefined();
  });

  it.each([
    ['', /Enter a name/],
    ['-x', /cannot start with “-”/],
    ['--upload-pack=evil', /cannot start with “-”/],
    ['my fork', /cannot contain spaces/],
    ['tab\there', /cannot contain spaces/],
    ['a..b', /A remote name cannot contain “\.\.”/],
    ['a:b', /A remote name contains a forbidden character/],
    ['x~1', /forbidden character/],
    ['bell\u0007', /forbidden character/],
    ['@', /A remote name cannot be “@”/],
    ['team/', /cannot start or end with “\/”/],
    ['.hidden', /cannot start with “\.”/],
    ['ci.lock', /\.lock/],
  ])('rejects %j', (name, message) => {
    expect(validateRemoteName(name)).toMatch(message);
  });
});

describe('validateRemoteUrl', () => {
  it.each([
    'https://github.com/ann/app.git',
    'https://ann:token@github.com/ann/app.git',
    'ssh://git@example.com:2222/app.git',
    'git@github.com:ann/app.git',
    'file:///srv/git/app.git',
    '/srv/git/My Projects/app.git',
    '../app.git',
    'C:\\Users\\ann\\app.git',
  ])('accepts %s', (url) => {
    expect(validateRemoteUrl(url)).toBeUndefined();
  });

  it.each([
    ['', /Enter the URL/],
    ['   ', /Enter the URL/],
    ['-oProxyCommand=touch x', /cannot start with “-”/],
    [' --upload-pack=touch x', /cannot start with “-”/],
    ['/srv/app.git\n[core]', /control characters/],
    ['https://example.com/\u0000', /control characters/],
  ])('rejects %j', (url, message) => {
    expect(validateRemoteUrl(url)).toMatch(message);
  });
});

describe('remoteBranchesOf', () => {
  const ref = (name: string, kind: RefInfo['kind'] = 'remote'): RefInfo => ({
    name,
    short: name.replace(/^refs\/(?:heads|remotes|tags)\//, ''),
    kind,
    target: 'a'.repeat(40),
  });
  const refs = [
    ref('refs/heads/team/main', 'branch'),
    ref('refs/remotes/team/main'),
    ref('refs/remotes/team/feature/x'),
    ref('refs/remotes/team/ci/main'),
    ref('refs/remotes/teammate/main'),
  ];

  it('takes the remote’s own branches, not those of a remote nested in its name', () => {
    expect(remoteBranchesOf(refs, 'team', ['team', 'team/ci', 'teammate'])).toEqual([
      'refs/remotes/team/main',
      'refs/remotes/team/feature/x',
    ]);
    expect(remoteBranchesOf(refs, 'team/ci', ['team', 'team/ci'])).toEqual(['refs/remotes/team/ci/main']);
    // Without a remote named team/ci, those branches are team's.
    expect(remoteBranchesOf(refs, 'team', ['team'])).toHaveLength(3);
  });
});

describe('withoutCredentials', () => {
  it('hides credentials in what a plan shows, and says when there were none', () => {
    const plain = [{ args: ['fetch', 'origin'], explanation: 'Fetch.', flags: [] }];
    expect(withoutCredentials(plain)).toBeUndefined();
    const secret = 'https://ann:s3cret@example.com/app.git';
    const shown = withoutCredentials([
      ...plain,
      {
        args: ['remote', 'add', '--', 'team', secret],
        onFailure: ['remote', 'remove', secret],
        fallback: ['remote', 'set-url', '--', 'team', secret],
        explanation: 'Add it.',
        flags: [],
      },
    ]);
    expect(shown?.[0]).toEqual(plain[0]);
    expect(shown?.[1]).toEqual({
      args: ['remote', 'add', '--', 'team', 'https://***@example.com/app.git'],
      onFailure: ['remote', 'remove', 'https://***@example.com/app.git'],
      fallback: ['remote', 'set-url', '--', 'team', 'https://***@example.com/app.git'],
      explanation: 'Add it.',
      flags: [],
    });
    expect(JSON.stringify(shown)).not.toContain('s3cret');
  });
});
