import { describe, expect, it } from 'vitest';
import { parseSshHostName, parseUrlRewrites } from '../../src/core/repo/codeHosts';
import {
  codeHostOf,
  isKnownHost,
  linkMessage,
  linkUrl,
  parseRemoteUrl,
  preferHosts,
  readLinkSettings,
  rewriteUrl,
  type CodeHost,
  type LinkSettings,
} from '../../src/shared/codeHosts';

const SHA = '4b533950c1d2e9f0a1b2c3d4e5f60718293a4b5c';

function hostOf(url: string, settings: LinkSettings['hosts'] = {}, remote = 'origin'): CodeHost | undefined {
  const address = parseRemoteUrl(url);
  return address && codeHostOf(remote, address, settings);
}

describe('parseRemoteUrl', () => {
  it('reads https, ssh, git and scp-like URLs, credentials left out', () => {
    expect(parseRemoteUrl('https://github.com/acme/aurora.git')).toEqual({
      scheme: 'https',
      host: 'github.com',
      path: 'acme/aurora',
    });
    expect(parseRemoteUrl('https://x-access-token:secret@GitHub.com/acme/aurora/')).toEqual({
      scheme: 'https',
      host: 'github.com',
      path: 'acme/aurora',
    });
    expect(parseRemoteUrl('ssh://git@git.example.com:2222/group/sub/repo.git')).toEqual({
      scheme: 'ssh',
      host: 'git.example.com',
      port: 2222,
      path: 'group/sub/repo',
    });
    expect(parseRemoteUrl('git@github.com:acme/aurora.git')).toEqual({
      scheme: 'ssh',
      host: 'github.com',
      path: 'acme/aurora',
    });
    expect(parseRemoteUrl('github-work:acme/aurora')).toEqual({
      scheme: 'ssh',
      host: 'github-work',
      path: 'acme/aurora',
    });
    expect(parseRemoteUrl('git://example.org/pub/scm/tool.git')).toMatchObject({
      scheme: 'git',
      path: 'pub/scm/tool',
    });
    expect(parseRemoteUrl('git+ssh://git@host.example/repo.git')).toMatchObject({ scheme: 'ssh' });
  });

  it('finds no host in local paths and file URLs', () => {
    expect(parseRemoteUrl('/srv/git/aurora.git')).toBeUndefined();
    expect(parseRemoteUrl('../aurora')).toBeUndefined();
    expect(parseRemoteUrl('C:\\repos\\aurora')).toBeUndefined();
    expect(parseRemoteUrl('C:/repos/aurora')).toBeUndefined();
    expect(parseRemoteUrl('file:///srv/git/aurora.git')).toBeUndefined();
  });
});

describe('rewriteUrl', () => {
  it('applies the longest matching insteadOf prefix', () => {
    const rewrites = [
      { base: 'git@github.com:', prefix: 'gh:' },
      { base: 'https://github.com/', prefix: 'https://mirror.example/' },
      { base: 'https://github.com/acme/', prefix: 'https://mirror.example/acme/' },
    ];
    expect(rewriteUrl('gh:acme/aurora', rewrites)).toBe('git@github.com:acme/aurora');
    expect(rewriteUrl('https://mirror.example/acme/aurora', rewrites)).toBe('https://github.com/acme/aurora');
    expect(rewriteUrl('https://gitlab.com/acme/aurora', rewrites)).toBe('https://gitlab.com/acme/aurora');
  });
});

describe('reading git and ssh settings', () => {
  it('reads insteadOf rewrites from git config', () => {
    const config =
      'url.git@github.com:.insteadof\ngh:\0url.https://a.example/x.y/.insteadof\nmirror:\0remote.origin.url\nx\0';
    expect(parseUrlRewrites(config)).toEqual([
      { base: 'git@github.com:', prefix: 'gh:' },
      { base: 'https://a.example/x.y/', prefix: 'mirror:' },
    ]);
  });

  it('reads the host name of an alias from ssh -G', () => {
    expect(parseSshHostName('user git\nhostname GitHub.com\nport 22\n')).toBe('github.com');
    expect(parseSshHostName('user git\nport 22\n')).toBeUndefined();
  });
});

describe('codeHostOf', () => {
  it('knows the public hosts', () => {
    expect(hostOf('git@github.com:acme/aurora.git')).toEqual({
      remote: 'origin',
      kind: 'github',
      name: 'GitHub',
      url: 'https://github.com/acme/aurora',
      repository: 'acme/aurora',
    });
    expect(hostOf('ssh://git@ssh.github.com:443/acme/aurora.git')?.url).toBe(
      'https://github.com/acme/aurora',
    );
    expect(hostOf('https://gitlab.com/acme/platform/web.git')).toMatchObject({
      kind: 'gitlab',
      url: 'https://gitlab.com/acme/platform/web',
      repository: 'acme/platform/web',
    });
    expect(hostOf('git@bitbucket.org:acme/aurora.git')).toMatchObject({
      kind: 'bitbucket',
      url: 'https://bitbucket.org/acme/aurora',
    });
    expect(hostOf('https://codeberg.org/acme/aurora.git')).toMatchObject({ kind: 'gitea', name: 'Codeberg' });
  });

  it('reads Azure DevOps URLs in all their forms', () => {
    const url = 'https://dev.azure.com/acme/Web%20Apps/_git/site';
    expect(hostOf('https://acme@dev.azure.com/acme/Web%20Apps/_git/site')).toMatchObject({
      kind: 'azure',
      name: 'Azure DevOps',
      url,
      repository: 'acme/Web Apps/site',
    });
    expect(hostOf('git@ssh.dev.azure.com:v3/acme/Web%20Apps/site')?.url).toBe(url);
    expect(hostOf('acme@vs-ssh.visualstudio.com:v3/acme/Web%20Apps/site')?.url).toBe(url);
    expect(hostOf('https://acme.visualstudio.com/DefaultCollection/Web/_git/site')).toMatchObject({
      url: 'https://acme.visualstudio.com/DefaultCollection/Web/_git/site',
      repository: 'acme/Web/site',
    });
    expect(hostOf('https://dev.azure.com/acme/_git/site')).toMatchObject({ repository: 'acme/site' });
    // Azure DevOps Server, told by its path.
    expect(hostOf('https://tfs.example.com/tfs/Main/Web/_git/site')?.url).toBe(
      'https://tfs.example.com/tfs/Main/Web/_git/site',
    );
  });

  it('reads Bitbucket Server URLs over https and SSH', () => {
    expect(hostOf('https://bitbucket.example.com/scm/plat/api.git')).toMatchObject({
      kind: 'bitbucketServer',
      url: 'https://bitbucket.example.com/projects/PLAT/repos/api',
      repository: 'PLAT/api',
    });
    expect(
      hostOf('https://example.com/bitbucket/scm/~erin/notes.git', { 'example.com': 'bitbucketServer' })?.url,
    ).toBe('https://example.com/bitbucket/users/erin/repos/notes');
    expect(hostOf('ssh://git@bitbucket.example.com:7999/plat/api.git')?.url).toBe(
      'https://bitbucket.example.com/projects/PLAT/repos/api',
    );
  });

  it('tells self-hosted servers by their names, and keeps an https port', () => {
    expect(hostOf('https://gitlab.example.com:8443/group/repo.git')?.url).toBe(
      'https://gitlab.example.com:8443/group/repo',
    );
    expect(hostOf('git@github.example.com:acme/aurora.git')).toMatchObject({
      kind: 'github',
      name: 'GitHub',
    });
    expect(hostOf('git@forgejo.example.com:acme/aurora.git')).toMatchObject({
      kind: 'gitea',
      name: 'Forgejo',
    });
    expect(hostOf('git@git.example.com:acme/aurora.git')).toBeUndefined();
  });

  it('takes hosts from the settings, with their web address', () => {
    const settings = readLinkSettings(
      {
        'git.example.com': 'gitlab',
        'GIT.CORP.example': { type: 'gitea', url: 'https://code.corp.example/', name: 'Corp Code' },
      },
      [],
    ).hosts;
    expect(hostOf('ssh://git@git.example.com:2222/group/repo.git', settings)?.url).toBe(
      'https://git.example.com/group/repo',
    );
    expect(hostOf('git@git.corp.example:team/app.git', settings)).toMatchObject({
      kind: 'gitea',
      name: 'Corp Code',
      url: 'https://code.corp.example/team/app',
    });
    expect(isKnownHost('git.example.com', settings)).toBe(true);
    expect(isKnownHost('github-work', settings)).toBe(false);
    expect(isKnownHost('github.com', {})).toBe(true);
  });

  it('names no repository for paths that are not one', () => {
    expect(hostOf('https://github.com/acme')).toBeUndefined();
    expect(hostOf('https://github.com/acme/aurora/extra')).toBeUndefined();
    expect(hostOf('https://dev.azure.com/acme/web')).toBeUndefined();
  });
});

describe('readLinkSettings', () => {
  it('leaves out what is not well-formed', () => {
    const settings = readLinkSettings(
      { a: 'gitlab', b: 'svn', c: { type: 'nope' }, d: { type: 'github', url: 'javascript:alert(1)' } },
      [
        { prefix: 'PROJ-', url: 'https://jira.example.com/browse/PROJ-<num>' },
        { prefix: 'X-', url: 'https://example.com/without-number' },
        { prefix: '', url: 'https://example.com/<num>' },
        'nonsense',
      ],
    );
    expect(settings.hosts).toEqual({ a: 'gitlab', d: { type: 'github', url: undefined, name: undefined } });
    expect(settings.autolinks).toEqual([
      { prefix: 'PROJ-', url: 'https://jira.example.com/browse/PROJ-<num>' },
    ]);
  });
});

describe('preferHosts', () => {
  it('prefers upstream, then origin, then the rest as configured', () => {
    const host = (remote: string) => hostOf(`https://github.com/${remote}/aurora.git`, {}, remote)!;
    expect(
      preferHosts([host('mirror'), host('origin'), host('fork'), host('upstream')]).map((h) => h.remote),
    ).toEqual(['upstream', 'origin', 'mirror', 'fork']);
  });
});

describe('linkUrl', () => {
  const github = hostOf('git@github.com:acme/aurora.git')!;
  const gitlab = hostOf('git@gitlab.com:acme/web.git')!;
  const gitea = hostOf('git@codeberg.org:acme/aurora.git')!;
  const bitbucket = hostOf('git@bitbucket.org:acme/aurora.git')!;
  const server = hostOf('https://bitbucket.example.com/scm/plat/api.git')!;
  const azure = hostOf('https://dev.azure.com/acme/web/_git/site')!;

  it('links commits', () => {
    const commit = { kind: 'commit', sha: SHA } as const;
    expect(linkUrl(github, commit)).toBe(`https://github.com/acme/aurora/commit/${SHA}`);
    expect(linkUrl(gitlab, commit)).toBe(`https://gitlab.com/acme/web/-/commit/${SHA}`);
    expect(linkUrl(gitea, commit)).toBe(`https://codeberg.org/acme/aurora/commit/${SHA}`);
    expect(linkUrl(bitbucket, commit)).toBe(`https://bitbucket.org/acme/aurora/commits/${SHA}`);
    expect(linkUrl(server, commit)).toBe(
      `https://bitbucket.example.com/projects/PLAT/repos/api/commits/${SHA}`,
    );
    expect(linkUrl(azure, commit)).toBe(`https://dev.azure.com/acme/web/_git/site/commit/${SHA}`);
  });

  it('links files and lines, each host its own way', () => {
    const file = (start?: number, end?: number) =>
      ({
        kind: 'file',
        sha: SHA,
        path: 'src/a b#.ts',
        lines: start === undefined ? undefined : { start, end: end ?? start },
      }) as const;
    expect(linkUrl(github, file())).toBe(`https://github.com/acme/aurora/blob/${SHA}/src/a%20b%23.ts`);
    expect(linkUrl(github, file(3, 7))).toBe(
      `https://github.com/acme/aurora/blob/${SHA}/src/a%20b%23.ts#L3-L7`,
    );
    // One line: the cursor's, when nothing is selected.
    expect(linkUrl(github, file(3))).toMatch(/\/src\/a%20b%23\.ts#L3$/);
    expect(linkUrl(bitbucket, file(3))).toMatch(/\/src\/a%20b%23\.ts#lines-3$/);
    expect(linkUrl(server, file(3))).toMatch(/\?at=[0-9a-f]{40}#3$/);
    expect(linkUrl(gitlab, file(3, 7))).toBe(
      `https://gitlab.com/acme/web/-/blob/${SHA}/src/a%20b%23.ts#L3-7`,
    );
    expect(linkUrl(gitea, file(3, 7))).toBe(
      `https://codeberg.org/acme/aurora/src/commit/${SHA}/src/a%20b%23.ts#L3-L7`,
    );
    expect(linkUrl(bitbucket, file(3, 7))).toBe(
      `https://bitbucket.org/acme/aurora/src/${SHA}/src/a%20b%23.ts#lines-3:7`,
    );
    expect(linkUrl(server, file(3, 7))).toBe(
      `https://bitbucket.example.com/projects/PLAT/repos/api/browse/src/a%20b%23.ts?at=${SHA}#3-7`,
    );
    expect(linkUrl(azure, file(3, 7))).toBe(
      `https://dev.azure.com/acme/web/_git/site?path=%2Fsrc%2Fa%20b%23.ts&version=GC${SHA}&line=3&lineEnd=8&lineStartColumn=1&lineEndColumn=1&lineStyle=plain&_a=contents`,
    );
  });

  it('shows the source of rendered files when linking lines', () => {
    const readme = (lines?: { start: number; end: number }) =>
      ({ kind: 'file', sha: SHA, path: 'README.md', lines }) as const;
    expect(linkUrl(github, readme({ start: 5, end: 5 }))).toBe(
      `https://github.com/acme/aurora/blob/${SHA}/README.md?plain=1#L5`,
    );
    expect(linkUrl(github, readme())).toBe(`https://github.com/acme/aurora/blob/${SHA}/README.md`);
    expect(linkUrl(gitea, readme({ start: 5, end: 6 }))).toMatch(/README\.md\?display=source#L5-L6$/);
  });

  it('links branches, tags and comparisons where the host has pages for them', () => {
    expect(linkUrl(github, { kind: 'branch', name: 'feature/login' })).toBe(
      'https://github.com/acme/aurora/tree/feature/login',
    );
    expect(linkUrl(gitlab, { kind: 'branch', name: 'feature/login' })).toBe(
      'https://gitlab.com/acme/web/-/tree/feature/login',
    );
    expect(linkUrl(gitea, { kind: 'branch', name: 'main' })).toBe(
      'https://codeberg.org/acme/aurora/src/branch/main',
    );
    expect(linkUrl(server, { kind: 'branch', name: 'feature/x' })).toBe(
      'https://bitbucket.example.com/projects/PLAT/repos/api/browse?at=refs/heads/feature/x',
    );
    expect(linkUrl(azure, { kind: 'branch', name: 'feature/x' })).toBe(
      'https://dev.azure.com/acme/web/_git/site?version=GBfeature%2Fx',
    );
    expect(linkUrl(github, { kind: 'tag', name: '@acme/ui@1.0.0' })).toBe(
      'https://github.com/acme/aurora/tree/%40acme/ui%401.0.0',
    );
    expect(linkUrl(gitlab, { kind: 'tag', name: 'v1.0' })).toBe('https://gitlab.com/acme/web/-/tags/v1.0');
    expect(linkUrl(github, { kind: 'compare', from: 'a1', to: 'b2' })).toBe(
      'https://github.com/acme/aurora/compare/a1...b2',
    );
    expect(linkUrl(bitbucket, { kind: 'compare', from: 'a1', to: 'b2' })).toBeUndefined();
  });
});

describe('linkMessage', () => {
  const github = hostOf('git@github.com:acme/aurora.git')!;
  const gitlab = hostOf('git@gitlab.com:acme/web.git')!;
  const azure = hostOf('https://dev.azure.com/acme/web/_git/site')!;
  const links = (text: string, host?: CodeHost, autolinks = []) =>
    linkMessage(text, host, autolinks)
      .filter((part) => part.url)
      .map((part) => [part.text, part.url]);

  it('links issues of the host, and keeps the rest of the text as it is', () => {
    const parts = linkMessage('Fix the offset (#42), see GH-7.', github);
    expect(parts.map((part) => part.text).join('')).toBe('Fix the offset (#42), see GH-7.');
    expect(links('Fix the offset (#42), see GH-7.', github)).toEqual([
      ['#42', 'https://github.com/acme/aurora/issues/42'],
      ['GH-7', 'https://github.com/acme/aurora/issues/7'],
    ]);
    expect(links('Closes acme/other#3', github)).toEqual([
      ['acme/other#3', 'https://github.com/acme/other/issues/3'],
    ]);
    expect(links('See !12 and group/sub/app#3', gitlab)).toEqual([
      ['!12', 'https://gitlab.com/acme/web/-/merge_requests/12'],
      ['group/sub/app#3', 'https://gitlab.com/group/sub/app/-/issues/3'],
    ]);
    expect(links('AB task #881', azure)).toEqual([
      ['#881', 'https://dev.azure.com/acme/web/_workitems/edit/881'],
    ]);
  });

  it('leaves what only looks like a reference', () => {
    expect(links('C#1 &#39; issue#2 x!3 Wow!4 a@b#5', github)).toEqual([]);
    expect(links('#42 with no host')).toEqual([]);
  });

  it('links web addresses, without the punctuation after them', () => {
    expect(links('Docs (https://example.com/a_(b)) and https://example.com/x.', github)).toEqual([
      ['https://example.com/a_(b)', 'https://example.com/a_(b)'],
      ['https://example.com/x', 'https://example.com/x'],
    ]);
    // An address with an issue-like fragment is one link.
    expect(links('https://github.com/acme/aurora/pull/9#issuecomment-1', github)).toEqual([
      [
        'https://github.com/acme/aurora/pull/9#issuecomment-1',
        'https://github.com/acme/aurora/pull/9#issuecomment-1',
      ],
    ]);
  });

  it('links the configured autolinks, with or without a host', () => {
    const autolinks = [
      { prefix: 'PROJ-', url: 'https://jira.example.com/browse/PROJ-<num>' },
      { prefix: 'TICKET:', url: 'https://desk.example.com/t/<num>', alphanumeric: true },
    ];
    expect(links('PROJ-12 and TICKET:ab3, not XPROJ-1', undefined, autolinks as never)).toEqual([
      ['PROJ-12', 'https://jira.example.com/browse/PROJ-12'],
      ['TICKET:ab3', 'https://desk.example.com/t/ab3'],
    ]);
  });
});
