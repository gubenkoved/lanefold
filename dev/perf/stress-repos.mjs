// Builds repositories that stress what a long history does not: very many refs, a commit that
// changes thousands of files, and a working tree with thousands of changes.
//
//   node dev/perf/stress-repos.mjs refs <target-dir> [tags=20000]
//   node dev/perf/stress-repos.mjs wide <target-dir> [files=30000]
//
// refs: 5,000 commits with tags on most of them (one in ten annotated), 3,000 remote branches
//       and 50 local branches.
// wide: one commit adds the files (in 300 folders), the next rewrites two thirds of them; then a
//       quarter of them are edited and 4,000 untracked files are added, so `git status` lists
//       11,500 entries.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [kind, targetArg, countArg] = process.argv.slice(2);
if (kind !== 'refs' && kind !== 'wide') {
  console.error('usage: stress-repos.mjs refs|wide <target-dir> [count]');
  process.exit(2);
}
const target = resolve(targetArg ?? `out/perf/stress-${kind}`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const git = (...args) =>
  execFileSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: 1 << 30 }).trim();
git('init', '-q', '--initial-branch=main');

const data = (text) => `data ${Buffer.byteLength(text)}\n${text}\n`;
let time = 1_700_000_000;
const signature = (who) =>
  `${who} <${who.toLowerCase().replace(/ /g, '.')}@example.com> ${(time += 60)} +0000`;

/** Feeds a fast-import stream to git (in one go; these streams are a few megabytes). */
function fastImport(stream) {
  const result = spawnSync('git', ['fast-import', '--quiet'], {
    cwd: target,
    input: stream,
    maxBuffer: 1 << 30,
  });
  if (result.status !== 0) throw new Error(`fast-import failed: ${result.stderr}`);
}

if (kind === 'refs') {
  const tags = Number(countArg ?? 20_000);
  const commits = 5_000;
  const parts = [];
  for (let i = 1; i <= commits; i++) {
    parts.push(`commit refs/heads/main\nmark :${i}\ncommitter ${signature('Rita Refs')}\n`);
    parts.push(data(`Change ${i}`));
    parts.push(`M 100644 inline file-${i % 200}.txt\n${data(`${i}\n`)}`);
  }
  for (let i = 0; i < tags; i++) {
    const mark = 1 + ((i * 7919) % commits);
    if (i % 10 === 0) {
      parts.push(
        `tag build-${String(i).padStart(5, '0')}\nfrom :${mark}\ntagger ${signature('Rita Refs')}\n`,
      );
      parts.push(data(`Build ${i}`));
    } else {
      parts.push(`reset refs/tags/build-${String(i).padStart(5, '0')}\nfrom :${mark}\n\n`);
    }
  }
  for (let i = 0; i < 3_000; i++) {
    parts.push(`reset refs/remotes/origin/pr/${i}\nfrom :${1 + ((i * 104729) % commits)}\n\n`);
  }
  for (let i = 0; i < 50; i++) {
    parts.push(`reset refs/heads/topic/${i}\nfrom :${commits - i * 37}\n\n`);
  }
  fastImport(parts.join(''));
  git('pack-refs', '--all');
  git('checkout', '-q', '-f', 'main');
  git('commit-graph', 'write', '--reachable');
  console.log(`${target}: ${commits} commits, ${tags} tags, 3000 remote branches, 51 branches`);
} else {
  const files = Number(countArg ?? 30_000);
  // Few folders: editors and git hosts watch every folder (inotify has a per-user limit).
  const path = (i) => `pkg-${i % 300}/file-${i}.ts`;
  const parts = [`commit refs/heads/main\ncommitter ${signature('Walt Wide')}\n`, data(`Add ${files} files`)];
  for (let i = 0; i < files; i++)
    parts.push(`M 100644 inline ${path(i)}\n${data(`export const v${i} = ${i};\n`)}`);
  const rewritten = Math.floor((files * 2) / 3);
  parts.push(
    `commit refs/heads/main\ncommitter ${signature('Walt Wide')}\n`,
    data(`Rewrite ${rewritten} files`),
  );
  for (let i = 0; i < rewritten; i++) {
    parts.push(`M 100644 inline ${path(i)}\n${data(`export const v${i} = ${i * 2};\n// rewritten\n`)}`);
  }
  for (let c = 0; c < 50; c++) {
    parts.push(`commit refs/heads/main\ncommitter ${signature('Walt Wide')}\n`, data(`Small change ${c}`));
    parts.push(`M 100644 inline ${path(c)}\n${data(`export const small = ${c};\n`)}`);
  }
  fastImport(parts.join(''));
  git('checkout', '-q', '-f', 'main');
  // Uncommitted: a quarter of the files edited, and a folder of new files.
  for (let i = 0; i < files; i += 4) appendFileSync(join(target, path(i)), '// local edit\n');
  mkdirSync(join(target, 'scratch'), { recursive: true });
  for (let i = 0; i < 4_000; i++) writeFileSync(join(target, 'scratch', `note-${i}.md`), `note ${i}\n`);
  console.log(
    `${target}: ${files} files, a commit changing ${rewritten}, ${files / 4} edited, 4000 untracked`,
  );
}
