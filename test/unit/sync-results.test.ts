import { describe, expect, it } from 'vitest';
import { GitError } from '../../src/core/git/errors';
import { describeGitFailure } from '../../src/core/ops/results';
import { describeMoves, describeRemoteFailure, refMoves } from '../../src/core/ops/syncResults';

const sha = (n: number) => String(n).repeat(40).slice(0, 40);

describe('refMoves / describeMoves', () => {
  const before = new Map([
    ['refs/remotes/origin/main', sha(1)],
    ['refs/remotes/origin/old', sha(2)],
    ['refs/remotes/origin/same', sha(3)],
    ['refs/remotes/team/main', sha(4)],
    ['refs/remotes/team/ci/main', sha(5)],
  ]);
  const after = new Map([
    ['refs/remotes/origin/main', sha(6)],
    ['refs/remotes/origin/new', sha(7)],
    ['refs/remotes/origin/same', sha(3)],
    ['refs/remotes/team/main', sha(4)],
    ['refs/remotes/team/ci/main', sha(8)],
    ['refs/tags/v1', sha(9)],
  ]);

  it('tells what came, moved and went under a prefix', () => {
    expect(refMoves(before, after, 'refs/remotes/origin/')).toEqual({
      added: ['refs/remotes/origin/new'],
      updated: ['refs/remotes/origin/main'],
      removed: ['refs/remotes/origin/old'],
    });
    expect(refMoves(before, after, 'refs/tags/').added).toEqual(['refs/tags/v1']);
  });

  it('leaves out a remote nested in the name', () => {
    expect(refMoves(before, after, 'refs/remotes/team/', ['refs/remotes/team/ci/'])).toEqual({
      added: [],
      updated: [],
      removed: [],
    });
    expect(refMoves(before, after, 'refs/remotes/team/').updated).toEqual(['refs/remotes/team/ci/main']);
  });

  it('words the moves, naming what the first part counts', () => {
    const moves = (added: number, updated: number, removed: number) => ({
      added: Array.from({ length: added }, (_, i) => `a${i}`),
      updated: Array.from({ length: updated }, (_, i) => `u${i}`),
      removed: Array.from({ length: removed }, (_, i) => `r${i}`),
    });
    expect(describeMoves(moves(5, 2, 1), 14)).toBe('5 new branches, 2 updated, 1 removed (14 new commits)');
    expect(describeMoves(moves(1, 0, 0), 1)).toBe('1 new branch (1 new commit)');
    expect(describeMoves(moves(0, 2, 0), 3)).toBe('2 branches updated (3 new commits)');
    expect(describeMoves(moves(0, 0, 1), 0)).toBe('1 branch removed');
    expect(describeMoves(moves(0, 1, 2), 0)).toBe('1 branch updated, 2 removed');
    expect(describeMoves(moves(0, 0, 0), 0)).toBe('');
  });
});

describe('describeRemoteFailure', () => {
  // What git prints (credentials in URLs already hidden by the runner).
  const failure = (stderr: string, args = ['fetch', 'origin']) =>
    describeRemoteFailure(new GitError(args, 128, stderr, ''));

  it('says a host cannot be reached, or does not answer', () => {
    expect(
      failure(
        "fatal: unable to access 'https://***@nonexistent.invalid/app.git/': Could not resolve host: nonexistent.invalid",
      ),
    ).toBe('Could not reach nonexistent.invalid: there is no such host. Check the URL and your connection.');
    expect(
      failure(
        "fatal: unable to access 'https://127.0.0.1:9/app.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server",
      ),
    ).toBe('Could not connect to 127.0.0.1. Check the URL and your connection.');
    expect(
      failure(
        'ssh: connect to host git.example.com port 22: Connection refused\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.',
      ),
    ).toBe('Could not connect to git.example.com. Check the URL and your connection.');
    expect(
      failure(
        'ssh: Could not resolve hostname git.example.com: Temporary failure in name resolution\nfatal: Could not read from remote repository.',
      ),
    ).toBe('Could not reach git.example.com: there is no such host. Check the URL and your connection.');
  });

  it('names each remote a fetch of them all could not reach, and why', () => {
    const stderr = [
      'Fetching a-ok',
      'Fetching b-gone',
      "fatal: '/nonexistent/x.git' does not appear to be a git repository",
      'fatal: Could not read from remote repository.',
      '',
      'Please make sure you have the correct access rights',
      'and the repository exists.',
      'error: could not fetch b-gone',
      'Fetching c-dns',
      "fatal: unable to access 'https://nonexistent.invalid/x.git/': Could not resolve host: nonexistent.invalid",
      'error: could not fetch c-dns',
    ].join('\n');
    expect(failure(stderr, ['fetch', '--all'])).toBe(
      'Could not fetch b-gone (no git repository there) and c-dns (nonexistent.invalid cannot be reached).',
    );
  });

  it('says signing in was cancelled, refused, or could not be asked for', () => {
    expect(
      failure(
        "error: unable to read askpass response from '/home/ann/.vscode/askpass.sh'\nfatal: could not read Username for 'https://github.com': No such device or address",
      ),
    ).toBe('Signing in to github.com was cancelled.');
    expect(
      failure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    ).toBe(
      'github.com asks for a user name and password (or a token), and git could not ask you for them here. A credential helper can provide them.',
    );
    expect(failure("fatal: Authentication failed for 'https://***@github.com/ann/app.git/'")).toBe(
      'Signing in to github.com failed: the user name and password (or token) were not accepted.',
    );
    expect(
      failure(
        'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      ),
    ).toBe('github.com did not accept your SSH key.');
    expect(failure('Host key verification failed.\nfatal: Could not read from remote repository.')).toBe(
      'The SSH host key of the remote is unknown or has changed, so git did not connect.',
    );
    expect(
      failure(
        'No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.',
      ),
    ).toBe('The SSH host key of github.com is unknown or has changed, so git did not connect.');
  });

  it('says there is no repository there', () => {
    expect(
      failure(
        "fatal: '/srv/nowhere.git' does not appear to be a git repository\nfatal: Could not read from remote repository.",
      ),
    ).toBe('There is no git repository at /srv/nowhere.git.');
    expect(
      failure(
        "remote: Repository not found.\nfatal: repository 'https://github.com/ann/gone.git/' not found",
      ),
    ).toBe('There is no repository at https://github.com/ann/gone.git, or you have no access to it.');
  });

  it('leaves the rest to git’s own words, and other commands alone', () => {
    expect(
      failure(' ! [rejected]        main -> main (fetch first)', ['push', 'origin', 'main']),
    ).toBeUndefined();
    expect(failure('fatal: Connection refused', ['commit', '-m', 'x'])).toBeUndefined();
  });
});

describe('a delete the remote refused', () => {
  const deleting = (stderr: string) =>
    describeGitFailure(
      new GitError(
        [
          'push',
          `--force-with-lease=refs/heads/feature:${'a'.repeat(40)}`,
          'origin',
          '--delete',
          'refs/heads/feature',
        ],
        1,
        stderr,
        '',
      ),
    );

  it('says why, in words for a delete rather than a push', () => {
    expect(
      deleting(
        "To /srv/app.git\n ! [rejected]        (delete) -> feature (stale info)\nerror: failed to push some refs to '/srv/app.git'\n",
      ),
    ).toBe(
      'Not deleted: it changed on the remote since your last fetch, so the lease kept it. Fetch to see what is new there, then delete it again if you still want to.',
    );
    expect(
      deleting(
        "remote: error: refusing to delete the current branch: refs/heads/main\nTo /srv/app.git\n ! [remote rejected] main (deletion of the current branch prohibited)\nerror: failed to push some refs to '/srv/app.git'\n",
      ),
    ).toBe('Not deleted: it is the remote’s current branch, which the remote does not let anyone delete.');
    expect(
      deleting(
        "remote: error: GH006: Protected branch update failed for refs/heads/main.\nTo github.com:ann/app.git\n ! [remote rejected] main (protected branch hook declined)\nerror: failed to push some refs to 'github.com:ann/app.git'\n",
      ),
    ).toBe('Not deleted: the remote refused (protected branch hook declined).');
  });
});
