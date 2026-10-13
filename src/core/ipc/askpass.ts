import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type AskpassKind = 'username' | 'password' | 'passphrase' | 'confirm' | 'other';

export interface AskpassRequest {
  /** What git or ssh printed, e.g. "Password for 'https://alice@github.com': ". */
  readonly prompt: string;
  readonly kind: AskpassKind;
}

/**
 * Answers a prompt; `undefined` means the user cancelled (git then fails cleanly). `signal`
 * aborts when the asking process went away (the operation was cancelled): close the prompt.
 */
export type AskpassHandler = (request: AskpassRequest, signal: AbortSignal) => Promise<string | undefined>;

export function askpassKind(prompt: string): AskpassKind {
  if (/^username/i.test(prompt.trim())) return 'username';
  if (/passphrase/i.test(prompt)) return 'passphrase';
  if (/password|token|pin\b/i.test(prompt)) return 'password';
  if (/\(yes\/no(\/\[fingerprint\])?\)\??\s*$/i.test(prompt)) return 'confirm';
  return 'other';
}

/**
 * The extension's side of the credential bridge: git (GIT_ASKPASS) and ssh (SSH_ASKPASS) run
 * Lanefold's helper script, which posts the prompt here over a private socket and prints the
 * answer. Nothing is stored; credential helpers configured in git keep working as usual.
 */
export class AskpassServer {
  private constructor(
    private readonly server: Server,
    /** Unix socket path or Windows named pipe. */
    readonly handle: string,
    /** Every request must carry it: only processes Lanefold started know it. */
    private readonly token: string,
    /** The private folder holding the socket (POSIX). */
    private readonly folder: string | undefined,
  ) {}

  static start(handler: AskpassHandler): Promise<AskpassServer> {
    // POSIX: the socket sits in a folder only this user can enter (mkdtemp makes it 0700).
    const folder =
      process.platform === 'win32'
        ? undefined
        : mkdtempSync(join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), 'lanefold-'));
    const handle = folder ? join(folder, 'askpass.sock') : `\\\\.\\pipe\\lanefold-askpass-${randomUUID()}`;
    const token = randomBytes(24).toString('hex');
    const expected = Buffer.from(token);
    const server = createServer((request, response) => {
      const given = Buffer.from(String(request.headers['x-lanefold-token'] ?? ''));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        response.writeHead(403).end();
        return;
      }
      // The helper waits for the answer; if it goes away (git was stopped), so does the prompt.
      const asked = new AbortController();
      response.on('close', () => {
        if (!response.writableEnded) asked.abort();
      });
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy();
      });
      request.on('end', () => {
        let prompt: string;
        try {
          prompt = String((JSON.parse(body) as { prompt?: unknown }).prompt ?? '');
        } catch {
          response.writeHead(400).end();
          return;
        }
        handler({ prompt, kind: askpassKind(prompt) }, asked.signal).then(
          (answer) => {
            if (answer === undefined) response.writeHead(204).end();
            else
              response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ answer }));
          },
          () => response.writeHead(500).end(),
        );
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(handle, () => resolve(new AskpassServer(server, handle, token, folder)));
    });
  }

  /**
   * Environment for git commands. `script` is the shell wrapper git and ssh run; `main` the
   * Node script it starts with `node` (VS Code's Electron in node mode).
   */
  env(script: string, main: string, node: string): Record<string, string> {
    return {
      GIT_ASKPASS: script,
      SSH_ASKPASS: script,
      // Use the helper even with a terminal or without a display (OpenSSH ≥ 8.4).
      SSH_ASKPASS_REQUIRE: 'force',
      LANEFOLD_ASKPASS_HANDLE: this.handle,
      LANEFOLD_ASKPASS_TOKEN: this.token,
      LANEFOLD_ASKPASS_MAIN: main,
      LANEFOLD_NODE: node,
    };
  }

  dispose(): void {
    this.server.close();
    if (this.folder) rmSync(this.folder, { recursive: true, force: true });
  }
}
