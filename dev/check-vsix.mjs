// Checks a packaged VSIX: everything the extension needs is there, nothing else is, and the
// askpass helper keeps its executable bit (git runs it directly). Usage: node dev/check-vsix.mjs <file.vsix>
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node dev/check-vsix.mjs <file.vsix>');
  process.exit(2);
}

/** `zipinfo` lines: mode, version, os, size, type, method, date, time, name. */
const entries = execFileSync('zipinfo', [file], { encoding: 'utf8' })
  .split('\n')
  .map((line) => /^([-dlrwxs]{10})\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line))
  .filter(Boolean)
  .map(([, mode, size, name]) => ({ mode, size: Number(size), name }));

const required = [
  'extension.vsixmanifest',
  '[Content_Types].xml',
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
  'extension/media/logo/lanefold-256.png',
  'extension/media/lanefold.svg',
  'extension/media/lanefold-dark.svg',
  'extension/media/lanefold-light.svg',
  'extension/dist/extension.js',
  'extension/dist/logWorker.js',
  'extension/dist/scripts/askpass-main.js',
  'extension/dist/scripts/askpass.sh',
  'extension/dist/scripts/sequence-editor.js',
  'extension/dist/webview/main.js',
  'extension/dist/webview/main.css',
  'extension/dist/webview/THIRD_PARTY_LICENSES.md',
];
const allowed = [
  ...required.map((name) => new RegExp(`^${name.replace(/[[\].]/g, '\\$&')}$`)),
  /^extension\/dist\/webview\/assets\/codicon-[\w-]+\.ttf$/,
  /^extension\/dist\/webview\/chunks\/[\w-]+\.js$/,
  /^extension\/dist\/[\w-]+\.LEGAL\.txt$/,
];

const problems = [];
const names = new Set(entries.map((entry) => entry.name));
for (const name of required) if (!names.has(name)) problems.push(`missing: ${name}`);
if (!entries.some((entry) => /codicon-[\w-]+\.ttf$/.test(entry.name)))
  problems.push('missing: the codicon font');
for (const entry of entries) {
  if (!allowed.some((pattern) => pattern.test(entry.name))) problems.push(`unexpected: ${entry.name}`);
  if (entry.name.endsWith('.map')) problems.push(`source map shipped: ${entry.name}`);
}
const askpass = entries.find((entry) => entry.name === 'extension/dist/scripts/askpass.sh');
if (askpass && !askpass.mode.includes('x')) problems.push(`askpass.sh is not executable (${askpass.mode})`);

if (problems.length > 0) {
  console.error(`${file}:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
const total = entries.reduce((sum, entry) => sum + entry.size, 0);
console.log(`${file}: ${entries.length} files, ${(total / 1024).toFixed(0)} KB uncompressed — OK`);
