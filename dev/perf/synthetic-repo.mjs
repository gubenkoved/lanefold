// Builds a large synthetic repository for performance work, using `git fast-import`:
//
//   node dev/perf/synthetic-repo.mjs <target-dir> [commits=100000] [seed=1]
//
// The history mimics a busy project: a main line, short-lived feature branches merged back
// with merge commits, a few long-lived branches and tags. Hashes are deterministic per seed.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.argv[2] ?? 'out/perf/synthetic');
const total = Number(process.argv[3] ?? 100_000);
let seed = Number(process.argv[4] ?? 1) >>> 0;
const random = () => {
  // xorshift32: deterministic and fast.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};

const AUTHORS = [
  'Alice Archer <alice@example.com>',
  'Bob Builder <bob@example.com>',
  'Carol Chen <carol@example.com>',
  'Dan Dubois <dan@example.com>',
  'Eve Evans <eve@example.com>',
  'Frank Fischer <frank@example.com>',
];
const VERBS = ['Fix', 'Add', 'Refactor', 'Update', 'Remove', 'Improve', 'Document', 'Test'];
const NOUNS = [
  'parser',
  'cache',
  'login flow',
  'search index',
  'graph layout',
  'settings page',
  'API client',
  'build',
];

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
execFileSync('git', ['init', '-q', '--initial-branch=main', target]);

const importer = spawn('git', ['fast-import', '--quiet'], {
  cwd: target,
  stdio: ['pipe', 'inherit', 'inherit'],
});
const chunks = [];
let pending = 0;
const write = (text) => {
  chunks.push(text);
  pending += text.length;
  if (pending > 1 << 20) flush();
};
const flush = () => {
  if (chunks.length === 0) return;
  importer.stdin.write(chunks.join(''));
  chunks.length = 0;
  pending = 0;
};
const data = (text) => `data ${Buffer.byteLength(text)}\n${text}\n`;

let mark = 0;
let time = 1_600_000_000;
const branches = new Map(); // name -> head mark
let made = 0;
let featureCounter = 0;

function commit(ref, parents, message) {
  mark += 1;
  time += 30 + Math.floor(random() * 600);
  const author = AUTHORS[Math.floor(random() * AUTHORS.length)];
  let text = `commit ${ref}\nmark :${mark}\n`;
  text += `author ${author} ${time} +0000\ncommitter ${author} ${time} +0000\n`;
  text += data(message);
  if (parents[0]) text += `from :${parents[0]}\n`;
  for (const parent of parents.slice(1)) text += `merge :${parent}\n`;
  // Touch one of a few hundred files so trees stay small but diffs are real.
  text += `M 100644 inline src/file-${Math.floor(random() * 400)}.txt\n${data(`${mark}\n`)}`;
  write(text);
  made += 1;
  return mark;
}

const subject = () =>
  `${VERBS[Math.floor(random() * VERBS.length)]} ${NOUNS[Math.floor(random() * NOUNS.length)]} (#${made + 1})`;

let mainHead = commit('refs/heads/main', [], 'Initial commit');
while (made < total) {
  const roll = random();
  if (roll < 0.4 || (branches.size === 0 && roll >= 0.48)) {
    mainHead = commit('refs/heads/main', [mainHead], subject());
  } else if (roll < 0.48) {
    if (branches.size >= 60) {
      mainHead = commit('refs/heads/main', [mainHead], subject());
      continue;
    }
    const name = `feature/f${++featureCounter}`;
    branches.set(name, commit(`refs/heads/${name}`, [mainHead], subject()));
  } else if (roll < 0.9) {
    const names = [...branches.keys()];
    const name = names[Math.floor(random() * names.length)];
    branches.set(name, commit(`refs/heads/${name}`, [branches.get(name)], subject()));
  } else {
    const names = [...branches.keys()];
    const name = names[Math.floor(random() * names.length)];
    mainHead = commit('refs/heads/main', [mainHead, branches.get(name)], `Merge branch '${name}'`);
    // Most merged branches are deleted; some stay around.
    if (random() < 0.6) {
      branches.delete(name);
      write(`reset refs/heads/${name}\nfrom 0000000000000000000000000000000000000000\n\n`);
    }
  }
  if (made % 5000 === 0) write(`reset refs/tags/v${made / 5000}.0\nfrom :${mainHead}\n\n`);
}
flush();
importer.stdin.end();
await new Promise((resolveExit, reject) =>
  importer.on('exit', (code) =>
    code === 0 ? resolveExit() : reject(new Error(`fast-import exited ${code}`)),
  ),
);
execFileSync('git', ['checkout', '-q', '-f', 'main'], { cwd: target });
execFileSync('git', ['commit-graph', 'write', '--reachable'], { cwd: target });
console.log(`${target}: ${made} commits, ${branches.size} branches`);
