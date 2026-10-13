/**
 * Lanefold dev harness: serves the built webview in a normal browser and connects it to the
 * real core backend over a WebSocket. Used for development, Playwright e2e tests, screenshots
 * and performance traces.
 *
 *   npm run harness -- --repo /path/to/repo [--repo /another/repo] [--port 5177] [--theme dark-modern]
 *   open http://127.0.0.1:5177/?theme=light-modern&repo=/other/repo[&repo=/and/another]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { WebSocketServer, type WebSocket } from 'ws';
import { Backend } from '../../src/core/backend/backend';
import { ConsoleLog } from '../../src/core/console/consoleLog';
import { findGit, type GitBinary } from '../../src/core/git/binary';
import { GitRunner } from '../../src/core/git/runner';
import { RepositoryRegistry } from '../../src/core/repo/registry';
import { Repository } from '../../src/core/repo/repository';
import type { Disposable } from '../../src/core/util/emitter';
import { decodeMessage, encodeMessage } from '../../src/shared/codec';
import type { ThemeSnapshot } from '../../src/shared/protocol';
import type { RpcMessage, RpcTransport } from '../../src/shared/rpc';
import { HarnessPlatform } from './platform';
import { watchRepositoryFs } from './watch';

const { values: options } = parseArgs({
  options: {
    port: { type: 'string', default: '5177' },
    host: { type: 'string', default: '127.0.0.1' },
    repo: { type: 'string', multiple: true, default: [process.cwd()] },
    theme: { type: 'string', default: 'dark-modern' },
  },
});

const ROOT = process.cwd();
const WEBVIEW_DIR = join(ROOT, 'dist', 'webview');
const THEMES_DIR = join(ROOT, 'dev', 'harness', 'themes');
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.json': 'application/json',
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a request comes from the harness's own pages, a typed-in address or a tool (Playwright's
 * request API sends no browser headers). The harness runs git with the user's rights, so a page
 * on another site must not reach its socket or its debug endpoints: browsers name the requesting
 * site in `Origin` and `Sec-Fetch-Site`, and a rebound DNS name shows in `Host`.
 */
function trusted(request: IncomingMessage): boolean {
  const host = request.headers.host ?? '';
  const name = host.replace(/:\d+$/, '');
  if (!LOOPBACK.has(name) && !name.endsWith('.localhost') && name !== options.host) return false;
  const origin = request.headers.origin;
  if (origin !== undefined && URL.parse(origin)?.host !== host) return false;
  const site = request.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

const FORBIDDEN = 'The harness only answers its own pages on this machine.';

function loadTheme(name: string): ThemeSnapshot {
  for (const candidate of [name, 'fallback-dark']) {
    const file = join(THEMES_DIR, `${candidate}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ThemeSnapshot;
  }
  throw new Error('No harness theme found');
}

function availableThemes(): string[] {
  return readdirSync(THEMES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -5));
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function page(theme: ThemeSnapshot): string {
  const style = Object.entries(theme.variables)
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');
  return `<!DOCTYPE html>
<html lang="en" style="${escapeAttribute(style)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="/webview/main.css">
  <title>Lanefold harness</title>
</head>
<body class="${escapeAttribute(theme.bodyClass)}" data-vscode-theme-kind="${escapeAttribute(theme.themeKind)}">
  <div id="root"></div>
  <script id="lanefold-bootstrap" type="application/json">{"host":"harness"}</script>
  <script type="module" src="/webview/main.js"></script>
</body>
</html>`;
}

interface Session {
  readonly backend: Backend;
  readonly platform: HarnessPlatform;
  readonly registry: RepositoryRegistry;
  readonly disposables: Disposable[];
}

let gitBinary: Promise<GitBinary> | undefined;
const sessions = new Map<string, Promise<Session>>();

/**
 * Pages connected to each session. A session nobody has been connected to for a while is let go
 * (backend, watchers): e2e runs open hundreds, and each one's watchers count against the
 * machine's inotify limit. Reloads reconnect well within the grace period.
 */
const connections = new Map<string, { count: number; timer?: ReturnType<typeof setTimeout> }>();
const IDLE_SESSION_MS = 30_000;

function attachTo(key: string): void {
  const entry = connections.get(key) ?? { count: 0 };
  clearTimeout(entry.timer);
  entry.timer = undefined;
  entry.count++;
  connections.set(key, entry);
}

function detachFrom(key: string): void {
  const entry = connections.get(key);
  if (!entry || --entry.count > 0) return;
  entry.timer = setTimeout(() => {
    connections.delete(key);
    const pending = sessions.get(key);
    sessions.delete(key);
    void pending?.then(({ disposables }) => {
      for (const disposable of disposables) disposable.dispose();
    });
  }, IDLE_SESSION_MS);
  entry.timer.unref?.();
}

/** A session's key: its repositories (in order) and its id. */
function sessionKey(repoPaths: readonly string[], sessionId: string): string {
  return `${repoPaths.map((path) => resolve(path)).join('\u0001')}\u0000${sessionId}`;
}

/** The session a debug request names (`?repo=…&session=…`, like the page's own URL). */
function sessionOf(url: URL): Promise<Session> | undefined {
  const repos = url.searchParams.getAll('repo');
  return sessions.get(
    sessionKey(repos.length > 0 ? repos : [''], url.searchParams.get('session') ?? 'default'),
  );
}

/**
 * One backend per (repositories, session) pair. Browser tabs share a backend unless they pass
 * distinct `?session=` values (the e2e tests do, so parallel tests never share UI state). A
 * session can open several repositories (`?repo=a&repo=b`); the first one is the active one.
 */
function session(repoPaths: readonly string[], sessionId: string): Promise<Session> {
  const cacheKey = sessionKey(repoPaths, sessionId);
  let existing = sessions.get(cacheKey);
  if (!existing) {
    existing = (async () => {
      const console = new ConsoleLog();
      const registry = new RepositoryRegistry();
      const platform = new HarnessPlatform(
        undefined,
        join(ROOT, 'out', 'harness', 'logWorker.mjs'),
        // The harness runs from the repository: git runs the helper straight from the sources.
        join(ROOT, 'src', 'core', 'rebase', 'sequence-editor.cjs'),
      );
      const backend = new Backend({ platform, registry, console });
      const disposables: Disposable[] = [backend, registry, console];
      let binary: GitBinary;
      try {
        binary = await (gitBinary ??= findGit([process.env.LANEFOLD_GIT]));
      } catch (error) {
        // As in VS Code: the views load and say that git is missing.
        backend.setGit(undefined, error instanceof Error ? error.message : String(error));
        return { backend, platform, registry, disposables };
      }
      const runner = new GitRunner(binary, { listener: console });
      backend.setGit(runner);
      // Repositories of the session (those opened, then submodules or worktrees shown from them).
      platform.opener = async (folder) => {
        const opened = await Repository.open(runner, folder);
        if (opened && registry.add(opened))
          disposables.push(watchRepositoryFs(opened, (kinds) => registry.notifyChange(opened.id, kinds)));
        return opened && registry.get(opened.id);
      };
      for (const path of repoPaths) {
        const key = resolve(path);
        if (!(await platform.opener(key))) process.stderr.write(`[harness] ${key} is not a git repository\n`);
      }
      return { backend, platform, registry, disposables };
    })();
    sessions.set(cacheKey, existing);
  }
  return existing;
}

function serveStatic(response: ServerResponse, file: string): void {
  const full = normalize(join(WEBVIEW_DIR, file));
  if (!full.startsWith(WEBVIEW_DIR + sep) || !statSync(full, { throwIfNoEntry: false })?.isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': MIME[extname(full)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  response.end(readFileSync(full));
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  if (!trusted(request)) {
    response.writeHead(403).end(FORBIDDEN);
    return;
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (!existsSync(join(WEBVIEW_DIR, 'main.js'))) {
      response.writeHead(500).end('dist/webview is missing — run `npm run build:webview` first.');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(page(loadTheme(url.searchParams.get('theme') ?? options.theme!)));
  } else if (url.pathname.startsWith('/webview/')) {
    serveStatic(response, url.pathname.slice('/webview/'.length));
  } else if (url.pathname === '/favicon.ico') {
    response.writeHead(204).end();
  } else if (url.pathname === '/debug/diffs') {
    // For e2e tests: the diffs a session asked the (absent) editor to open.
    const pending = sessionOf(url);
    if (!pending) {
      response.writeHead(404).end('No such session');
      return;
    }
    void pending.then(({ platform }) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(platform.openedDiffs)),
    );
  } else if (url.pathname === '/debug/files') {
    // For e2e tests: files saved by the session, and what its next file pick returns (?pick=).
    const pending = sessionOf(url);
    if (!pending) {
      response.writeHead(404).end('No such session');
      return;
    }
    const pick = url.searchParams.get('pick');
    void pending.then(({ platform }) => {
      if (pick) platform.nextPick = pick;
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ saved: platform.savedFiles }));
    });
  } else if (url.pathname === '/debug/host-commands') {
    // For e2e tests: the host commands a session asked for (open a folder, settings, ...).
    const pending = sessionOf(url);
    if (!pending) {
      response.writeHead(404).end('No such session');
      return;
    }
    void pending.then(({ platform }) =>
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(platform.commands)),
    );
  } else if (url.pathname === '/debug/focus') {
    // For e2e tests: where the webview reports focus (whether Ctrl+Z would undo git operations).
    const pending = sessionOf(url);
    if (!pending) {
      response.writeHead(404).end('No such session');
      return;
    }
    void pending.then(({ platform }) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(platform.focus ?? null)),
    );
  } else if (url.pathname === '/debug/close-repository') {
    // For e2e tests: closes one of the session's repositories (as removing its workspace folder does).
    const pending = sessionOf(url);
    const folder = url.searchParams.get('folder');
    if (!pending || !folder) {
      response.writeHead(404).end('No such session');
      return;
    }
    void pending.then(({ registry }) => {
      const repo = registry.all.find((candidate) => candidate.root === resolve(folder));
      if (repo) registry.remove(repo.id);
      response.writeHead(repo ? 204 : 404).end();
    });
  } else if (url.pathname === '/debug/command') {
    // For e2e tests: what the extension sends the webview (open a file's history, reveal a commit).
    const pending = sessionOf(url);
    const command = url.searchParams.get('command');
    if (!pending || !command) {
      response.writeHead(404).end('No such session');
      return;
    }
    let args: unknown;
    try {
      args = JSON.parse(url.searchParams.get('args') ?? 'null');
    } catch {
      response.writeHead(400).end('args is not JSON');
      return;
    }
    void pending.then(({ backend }) => {
      backend.broadcast('command.run', { command, args });
      response.writeHead(204).end();
    });
  } else if (url.pathname === '/themes') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(availableThemes()));
  } else {
    response.writeHead(404).end('Not found');
  }
}

/**
 * WebSocket transport that buffers messages received before the backend attaches (the browser
 * sends its first requests as soon as the socket opens, while the session may still be loading).
 */
function socketTransport(socket: WebSocket): RpcTransport {
  const buffered: RpcMessage[] = [];
  let deliver: ((message: RpcMessage) => void) | undefined;
  socket.on('message', (data: Buffer) => {
    const message = decodeMessage(data.toString('utf8'));
    if (deliver) deliver(message);
    else buffered.push(message);
  });
  return {
    send: (message) => {
      if (socket.readyState === socket.OPEN) socket.send(encodeMessage(message));
    },
    onMessage: (handler) => {
      deliver = handler;
      // Replay after the endpoint finished registering its handlers.
      queueMicrotask(() => {
        for (const message of buffered.splice(0)) handler(message);
      });
      return () => {
        deliver = undefined;
      };
    },
  };
}

const server = createServer(handle);
const sockets = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (!trusted(request)) {
    socket.end(`HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n${FORBIDDEN}`);
    return;
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/rpc') {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => {
    const transport = socketTransport(ws);
    const repos = url.searchParams.getAll('repo');
    const paths = repos.length > 0 ? repos : options.repo!;
    const sessionId = url.searchParams.get('session') ?? 'default';
    const key = sessionKey(paths, sessionId);
    attachTo(key);
    ws.on('close', () => detachFrom(key));
    void session(paths, sessionId).then(({ backend, platform }) => {
      const endpoint = backend.connect(transport);
      endpoint.on('ui.focus', (focus) => (platform.focus = focus));
      ws.on('close', () => backend.disconnect(endpoint));
    });
  });
});

server.listen(Number(options.port), options.host, () => {
  console.log(
    `Lanefold harness on http://${options.host}:${options.port}/  (repo: ${options.repo!.map((path) => resolve(path)).join(', ')})`,
  );
  console.log(`Themes: ${availableThemes().join(', ')}`);
});

const shutdown = () => {
  sockets.close();
  server.close();
  void Promise.all([...sessions.values()]).then((all) => {
    for (const { disposables } of all) for (const d of disposables) d.dispose();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
