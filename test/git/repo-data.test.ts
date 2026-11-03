import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDemoRepo } from '../../dev/demo/makeDemoRepo';
import { LogEngine } from '../../src/core/log/logEngine';
import { revListArgs } from '../../src/core/log/revList';
import { RepoData } from '../../src/core/repo/repoData';
import { Repository } from '../../src/core/repo/repository';
import { GraphLayout } from '../../src/shared/graph/layout';
import { GraphTopology, type TopologyChunk } from '../../src/shared/graph/topology';
import type { TestRepo } from '../fixtures/repoBuilder';

describe('RepoData and LogEngine on the demo repository', () => {
  let demo: { repo: TestRepo; remote: TestRepo };
  let repo: Repository;
  let data: RepoData;

  beforeAll(async () => {
    demo = await buildDemoRepo();
    repo = (await Repository.open(demo.repo.runner, demo.repo.path))!;
    data = new RepoData(repo);
  });

  afterAll(async () => {
    data.dispose();
    await demo.repo.dispose();
    await demo.remote.dispose();
  });

  it('reads refs with upstream tracking and detects the trunk', async () => {
    const snapshot = await data.refs();
    const byName = new Map(snapshot.refs.map((ref) => [ref.short, ref]));
    expect(snapshot.trunk).toBe('main');
    expect(snapshot.head).toMatchObject({ branch: 'main', detached: false });
    expect(byName.get('main')).toMatchObject({
      kind: 'branch',
      isHead: true,
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
    });
    expect(byName.get('origin/review/maps')).toMatchObject({ kind: 'remote', remote: 'origin' });
    expect(byName.get('v1.0.0')).toMatchObject({ kind: 'tag', annotated: true });
    // Annotated tags are peeled to the commit they point at.
    expect(byName.get('v1.0.0')!.target).toBe(await demo.repo.rev('v1.0.0'));
  });

  it('summarizes the working tree', async () => {
    expect(await data.workingTree()).toEqual({ staged: 1, unstaged: 1, untracked: 0, conflicted: 0 });
  });

  it('serves commit metadata through the persistent object reader', async () => {
    const head = await demo.repo.rev('HEAD');
    const [merge] = (await demo.repo.log('main', '%H %s')).filter((line) =>
      line.includes("Merge branch 'feature/login'"),
    );
    const mergeSha = merge!.split(' ')[0]!;
    const metas = await data.commitMetas([head, mergeSha, 'f'.repeat(40)]);
    expect(metas).toHaveLength(2);
    expect(metas[0]).toMatchObject({
      sha: head,
      subject: 'Add dark mode toggle',
      author: 'Carol Chen',
      authorEmail: 'carol@aurora.dev',
    });
    expect(metas[1]!.parents).toHaveLength(2);
  });

  it('lists the files a commit changed, against its first parent', async () => {
    const [line] = (await demo.repo.log('main', '%H %s')).filter((l) =>
      l.includes("Merge branch 'feature/login'"),
    );
    const details = await data.commitDetails(line!.split(' ')[0]!);
    expect(details.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual([
      'A src/login.tsx',
      'A src/session.ts',
    ]);
    expect(details.body).toBe('');
    const root = await demo.repo.rev('main~100').catch(() => undefined);
    expect(root).toBeUndefined();
  });

  it('compares two branches in three-dot and two-dot modes', async () => {
    const threeDot = await data.compare('main', 'feature/search');
    expect(threeDot.onlyInA).toBe(3); // Update dependencies, Improve README, Add dark mode toggle
    expect(threeDot.onlyInB).toBe(3);
    expect(threeDot.files.map((f) => f.path).sort()).toEqual(['src/recent.ts', 'src/search.tsx']);
    const twoDot = await data.compare('main', 'feature/search', 'two-dot');
    expect(twoDot.files.length).toBeGreaterThan(threeDot.files.length);
    const between = await data.commitsBetween('main', 'feature/search');
    expect(between).toHaveLength(3);
  });

  it('lists the branches, remote branches and tags that contain a commit', async () => {
    const [line] = (await demo.repo.log('feature/login', '%H %s')).filter((l) =>
      l.includes('Validate credentials'),
    );
    const refs = await data.refsContaining(line!.split(' ')[0]!);
    // Merged into main (and pushed), so in everything branched from main since; not in the
    // hotfix or the experiment, which start before the merge.
    expect(refs.map((ref) => ref.short).sort()).toEqual([
      'feature/login',
      'feature/search',
      'main',
      'origin/feature/search',
      'origin/main',
      'v1.0.0',
    ]);
    expect(refs.find((ref) => ref.short === 'main')).toMatchObject({ kind: 'branch', isHead: true });
    expect(refs.find((ref) => ref.short === 'origin/main')).toMatchObject({
      kind: 'remote',
      remote: 'origin',
    });
    // Tags lead to their commit; upstreams are not read (their counts would cost a walk each).
    expect(refs.find((ref) => ref.short === 'v1.0.0')).toMatchObject({
      kind: 'tag',
      target: await demo.repo.rev('v1.0.0'),
    });
    expect(refs.every((ref) => ref.upstream === undefined)).toBe(true);
  });

  it('lists tags the oldest first, and nothing for a commit no ref leads to', async () => {
    const refs = await data.refsContaining(await demo.repo.rev('v0.1.0'));
    expect(refs.filter((ref) => ref.kind === 'tag').map((ref) => ref.short)).toEqual(['v0.1.0', 'v1.0.0']);
    const tree = await demo.repo.git('rev-parse', 'HEAD^{tree}');
    const loose = await demo.repo.git('commit-tree', tree, '-m', 'On no branch');
    expect(await data.refsContaining(loose)).toEqual([]);
  });

  it('streams the full history and lays it out', async () => {
    const head = await repo.head();
    const query = revListArgs({ scope: { type: 'all' } }, head, 'topo');
    const engine = new LogEngine();
    const topo = new GraphTopology(20);
    const chunks: TopologyChunk[] = [];
    const end = await new Promise<{ rowCount: number; error?: string }>((resolve) => {
      engine.open(repo, query.args!, {
        onChunk: (chunk) => {
          chunks.push(chunk);
          topo.appendChunk(chunk);
        },
        onEnd: resolve,
      });
    });
    topo.complete = true;
    expect(end.error).toBeUndefined();
    const expected = Number(
      await demo.repo.git('rev-list', '--count', '--branches', '--remotes', '--tags', 'HEAD'),
    );
    expect(end.rowCount).toBe(expected);
    expect(topo.rowCount).toBe(expected);
    expect(topo.oidHex(0)).toBe(await demo.repo.rev('HEAD'));

    const layout = new GraphLayout(topo, { elideAfter: 400, paletteSize: 10 });
    layout.run();
    expect(layout.rowsDone).toBe(expected);
    expect(layout.lanesInRange(0, expected - 1)).toBeGreaterThanOrEqual(3);
  });

  it('searches messages and authors within a view scope', async () => {
    const head = await repo.head();
    const all = { scope: { type: 'all' } } as const;
    const subjects = async (
      query: Parameters<RepoData['search']>[2],
      view: Parameters<RepoData['search']>[0] = all,
    ) => {
      const result = await data.search(view, head, query);
      const metas = await data.commitMetas(result.shas);
      return metas.map((m) => m.subject).sort();
    };
    // Plain text matches messages (case-insensitively) or author names.
    expect(await subjects({ text: 'SEARCH' })).toEqual([
      'Add city search box',
      'Debounce search requests',
      'Show recent searches',
    ]);
    expect(await subjects({ text: 'dubois' })).toEqual([
      'Fix timezone offset in daily view',
      'Prototype radar map layer',
      'Try vector tiles',
    ]);
    // Operators narrow it: text AND author, text AND message.
    expect(await subjects({ text: 'search', author: 'carol' })).toEqual(['Show recent searches']);
    expect(await subjects({ text: 'search', message: 'recent' })).toEqual(['Show recent searches']);
    // Regex metacharacters are literal.
    expect(await subjects({ text: '.*' })).toEqual([]);
    // Paths and scope limit the search.
    expect(await subjects({ paths: ['src/map.ts'] })).toEqual([
      'Prototype radar map layer',
      'Try vector tiles',
    ]);
    expect(await subjects({ text: 'search' }, { scope: { type: 'head' } })).toEqual([]);
    const capped = await data.search(all, head, { author: 'a' }, 2);
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.shas).toHaveLength(2);
  });

  it('streams from explicit starting commits fed through stdin', async () => {
    const head = await repo.head();
    const tip = await demo.repo.rev('feature/search');
    const query = revListArgs({ scope: { type: 'all' } }, head, 'topo', { tips: [tip] });
    const engine = new LogEngine();
    const end = await new Promise<{ rowCount: number; error?: string }>((resolve) => {
      engine.open(repo, query.args!, { onChunk: () => undefined, onEnd: resolve }, '', query.stdin);
    });
    expect(end.error).toBeUndefined();
    expect(end.rowCount).toBe(Number(await demo.repo.git('rev-list', '--count', 'feature/search')));
  });

  it('skips the query for an unborn HEAD view', () => {
    expect(
      revListArgs({ scope: { type: 'head' } }, { detached: false, unborn: true }, 'topo').args,
    ).toBeUndefined();
    expect(revListArgs({ scope: { type: 'all' } }, { detached: false, unborn: true }, 'date').args).toEqual([
      'rev-list',
      '--parents',
      '--date-order',
      '--branches',
      '--remotes',
      '--tags',
    ]);
    expect(
      revListArgs(
        { scope: { type: 'refs', refs: ['feature/*', 'main'] } },
        { detached: false, unborn: false },
        'topo',
      ).args,
    ).toEqual([
      'rev-list',
      '--parents',
      '--topo-order',
      '--glob=refs/heads/feature/*',
      '--end-of-options',
      'main',
    ]);
  });
});
