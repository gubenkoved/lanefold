import type { LanguageShare, LanguageStats } from '../../shared/stats';

/** File extensions (lower case, without the dot) and the language they are written in. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  pyi: 'Python',
  ipynb: 'Jupyter Notebook',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  scala: 'Scala',
  groovy: 'Groovy',
  gradle: 'Gradle',
  swift: 'Swift',
  m: 'Objective-C',
  mm: 'Objective-C++',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  'c++': 'C++',
  hh: 'C++',
  hpp: 'C++',
  hxx: 'C++',
  cs: 'C#',
  fs: 'F#',
  fsx: 'F#',
  vb: 'Visual Basic',
  rb: 'Ruby',
  php: 'PHP',
  pl: 'Perl',
  pm: 'Perl',
  lua: 'Lua',
  r: 'R',
  jl: 'Julia',
  dart: 'Dart',
  ex: 'Elixir',
  exs: 'Elixir',
  erl: 'Erlang',
  hrl: 'Erlang',
  hs: 'Haskell',
  clj: 'Clojure',
  cljs: 'Clojure',
  ml: 'OCaml',
  mli: 'OCaml',
  elm: 'Elm',
  zig: 'Zig',
  nim: 'Nim',
  v: 'Verilog',
  sv: 'SystemVerilog',
  vhd: 'VHDL',
  asm: 'Assembly',
  s: 'Assembly',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  fish: 'Shell',
  ps1: 'PowerShell',
  psm1: 'PowerShell',
  bat: 'Batchfile',
  cmd: 'Batchfile',
  html: 'HTML',
  htm: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sass: 'Sass',
  less: 'Less',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  md: 'Markdown',
  mdx: 'MDX',
  markdown: 'Markdown',
  rst: 'reStructuredText',
  adoc: 'AsciiDoc',
  tex: 'TeX',
  txt: 'Text',
  json: 'JSON',
  jsonc: 'JSON',
  json5: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  xsd: 'XML',
  plist: 'XML',
  csv: 'CSV',
  sql: 'SQL',
  graphql: 'GraphQL',
  gql: 'GraphQL',
  proto: 'Protocol Buffers',
  tf: 'HCL',
  hcl: 'HCL',
  nix: 'Nix',
  cmake: 'CMake',
  mk: 'Makefile',
  vim: 'Vim Script',
  svg: 'SVG',
};

/** Whole file names that say what they are. */
const NAMES: Readonly<Record<string, string>> = {
  dockerfile: 'Dockerfile',
  containerfile: 'Dockerfile',
  makefile: 'Makefile',
  gnumakefile: 'Makefile',
  'cmakelists.txt': 'CMake',
  rakefile: 'Ruby',
  gemfile: 'Ruby',
  jenkinsfile: 'Groovy',
};

/** The language a file is written in, from its name; undefined when it is not known ("Other"). */
export function languageOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const byName = NAMES[name];
  if (byName) return byName;
  if (name.startsWith('dockerfile.')) return 'Dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return EXTENSIONS[name.slice(dot + 1)];
}

export interface TreeFile {
  readonly path: string;
  readonly bytes: number;
}

/**
 * Parses `git ls-tree -r -l -z` ("<mode> <type> <object> <size>\t<path>" records): the files,
 * without symbolic links and submodules (they hold no code of their own).
 */
export function parseTree(output: string): TreeFile[] {
  const files: TreeFile[] = [];
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, , size] = record.slice(0, tab).split(/\s+/);
    if (type !== 'blob' || mode === '120000') continue;
    const bytes = Number(size);
    files.push({ path: record.slice(tab + 1), bytes: Number.isFinite(bytes) ? bytes : 0 });
  }
  return files;
}

/** Named languages shown at most; the rest join "Other". */
const MAX_LANGUAGES = 7;

/** The files by language, the largest (in bytes) first, with what is left as "Other" at the end. */
export function summarizeLanguages(files: readonly TreeFile[]): LanguageStats {
  const totals = new Map<string, { files: number; bytes: number }>();
  let other = { files: 0, bytes: 0 };
  let bytes = 0;
  for (const file of files) {
    bytes += file.bytes;
    const language = languageOf(file.path);
    let total = language ? totals.get(language) : other;
    if (!total) totals.set(language!, (total = { files: 0, bytes: 0 }));
    total.files++;
    total.bytes += file.bytes;
  }
  const ranked: LanguageShare[] = [...totals]
    .map(([language, total]) => ({ language, ...total }))
    .sort((a, b) => b.bytes - a.bytes || b.files - a.files || (a.language < b.language ? -1 : 1));
  for (const rest of ranked.splice(MAX_LANGUAGES)) {
    other = { files: other.files + rest.files, bytes: other.bytes + rest.bytes };
  }
  if (other.files > 0) ranked.push({ language: 'Other', ...other });
  return { languages: ranked, files: files.length, bytes };
}
