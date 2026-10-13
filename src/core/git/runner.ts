import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { redactCredentials } from '../../shared/shell';
import { featuresFor, type GitBinary, type GitFeatures } from './binary';
import { GitError } from './errors';

/** Configuration applied to every git invocation so output is stable and parseable. */
export const BASE_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.quotepath=false',
  '-c',
  'color.ui=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'i18n.logOutputEncoding=UTF-8',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
];

/**
 * Environment variables that would redirect git away from the repository we pass via `cwd`
 * (they are set, for example, when VS Code itself is launched from inside a git hook).
 */
const SCRUBBED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
];

const MAX_CAPTURED_STDERR = 64 * 1024;
const MAX_STDOUT_TAIL = 8 * 1024;

export interface GitRunOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  /** Extra environment; `undefined` values remove a variable. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string | Buffer;
  readonly signal?: AbortSignal;
  /**
   * Read-only commands run with `GIT_OPTIONAL_LOCKS=0` so background refreshes never
   * contend with the user's own git commands for `index.lock`.
   */
  readonly readOnly?: boolean;
  /** Exit codes treated as success (default `[0]`), e.g. `merge-tree` uses 1 for "conflicts". */
  readonly okExitCodes?: readonly number[];
  /** Short human label for the Git Console (e.g. "Load graph"). */
  readonly label?: string;
  /**
   * A chatty background query (status polling, HEAD lookups). Still reported to the Git Console,
   * but de-emphasized there and logged at trace level in the output channel.
   */
  readonly background?: boolean;
}

export interface GitResult<T = string> {
  readonly stdout: T;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface GitCommandStart {
  readonly id: number;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly label?: string;
  readonly readOnly: boolean;
  readonly background: boolean;
  readonly startedAt: number;
}

export interface GitCommandEnd extends GitCommandStart {
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly stderr: string;
  /** The last few KB of stdout, for commands that change state (shown in the Git Console). */
  readonly stdoutTail: string;
  readonly cancelled: boolean;
  /** It exited with a code its caller does not expect (`symbolic-ref` on a detached HEAD does not). */
  readonly failed: boolean;
}

export interface GitCommandListener {
  onCommandStart?(event: GitCommandStart): void;
  onCommandEnd?(event: GitCommandEnd): void;
}

export interface GitRunnerOptions {
  /** Environment applied to every command (askpass/editor bridges, etc.). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly listener?: GitCommandListener;
}

let nextCommandId = 1;

/** Spawns git (never through a shell) and reports every command to the listener. */
export class GitRunner {
  readonly features: GitFeatures;

  constructor(
    readonly binary: GitBinary,
    private readonly options: GitRunnerOptions = {},
  ) {
    this.features = featuresFor(binary.version);
  }

  /** Runs git and returns stdout decoded as UTF-8. Throws {@link GitError} on failure. */
  async run(opts: GitRunOptions): Promise<GitResult> {
    const chunks: Buffer[] = [];
    const result = await this.exec(opts, (chunk) => chunks.push(chunk));
    return { ...result, stdout: Buffer.concat(chunks).toString('utf8') };
  }

  /** Runs git and returns raw stdout bytes (file contents at a revision, patches, ...). */
  async runBuffer(opts: GitRunOptions): Promise<GitResult<Buffer>> {
    const chunks: Buffer[] = [];
    const result = await this.exec(opts, (chunk) => chunks.push(chunk));
    return { ...result, stdout: Buffer.concat(chunks) };
  }

  /** Runs git, handing each stdout chunk to `onStdout` as it arrives (nothing is buffered). */
  stream(opts: GitRunOptions, onStdout: (chunk: Buffer) => void): Promise<GitResult<undefined>> {
    return this.exec(opts, onStdout).then((result) => ({ ...result, stdout: undefined }));
  }

  buildEnv(opts: Pick<GitRunOptions, 'env' | 'readOnly'>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of SCRUBBED_ENV) delete env[name];
    Object.assign(env, {
      // Never block on a terminal prompt: credentials go through the askpass bridge.
      GIT_TERMINAL_PROMPT: '0',
      // Accept default messages unless an operation installs its own editor (rebase plans).
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      // English messages so errors can be classified, without touching the encoding locale.
      LANGUAGE: 'en_US:en',
    });
    if (opts.readOnly) env.GIT_OPTIONAL_LOCKS = '0';
    for (const source of [this.options.env, opts.env]) {
      if (!source) continue;
      for (const [key, value] of Object.entries(source)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    }
    return env;
  }

  /**
   * Starts a long-lived git process with an open stdin (e.g. `cat-file --batch`). The caller owns
   * the process; its whole lifetime is reported to the console as one command.
   */
  spawnProcess(
    opts: Omit<GitRunOptions, 'stdin' | 'signal' | 'okExitCodes'>,
  ): ChildProcessWithoutNullStreams {
    const listener = this.options.listener;
    const start: GitCommandStart = {
      id: nextCommandId++,
      cwd: opts.cwd,
      args: opts.args.map(redactCredentials),
      label: opts.label,
      readOnly: opts.readOnly ?? false,
      background: true,
      startedAt: Date.now(),
    };
    const t0 = performance.now();
    listener?.onCommandStart?.(start);
    const child = spawn(this.binary.path, [...BASE_CONFIG_ARGS, ...opts.args], {
      cwd: opts.cwd,
      env: this.buildEnv(opts),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED_STDERR) stderr += chunk.toString('utf8');
    });
    let reported = false;
    const report = (exitCode: number | null) => {
      if (reported) return;
      reported = true;
      listener?.onCommandEnd?.({
        ...start,
        durationMs: performance.now() - t0,
        exitCode: exitCode ?? 0,
        stderr: redactCredentials(stderr),
        stdoutTail: '',
        cancelled: false,
        failed: (exitCode ?? 0) !== 0,
      });
    };
    child.on('close', (code) => report(code));
    child.on('error', () => report(null));
    return child;
  }

  private exec(
    opts: GitRunOptions,
    onStdout: (chunk: Buffer) => void,
  ): Promise<{ stderr: string; exitCode: number; durationMs: number }> {
    const listener = this.options.listener;
    const start: GitCommandStart = {
      id: nextCommandId++,
      cwd: opts.cwd,
      args: opts.args.map(redactCredentials),
      label: opts.label,
      readOnly: opts.readOnly ?? false,
      background: opts.background ?? false,
      startedAt: Date.now(),
    };
    listener?.onCommandStart?.(start);
    const t0 = performance.now();

    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new GitError(start.args, null, 'Cancelled', '', { kind: 'cancelled', files: [] }));
        return;
      }

      const child = spawn(this.binary.path, [...BASE_CONFIG_ARGS, ...opts.args], {
        cwd: opts.cwd,
        env: this.buildEnv(opts),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      let stdoutTail = '';
      const keepTail = !opts.readOnly;
      let cancelled = false;
      let settled = false;

      const onAbort = () => {
        cancelled = true;
        child.kill();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        if (keepTail) {
          stdoutTail += chunk.toString('utf8');
          if (stdoutTail.length > MAX_STDOUT_TAIL) stdoutTail = stdoutTail.slice(-MAX_STDOUT_TAIL);
        }
        onStdout(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_CAPTURED_STDERR) stderr += chunk.toString('utf8');
      });
      // A process that exits before reading stdin raises EPIPE; the exit code tells the real story.
      child.stdin.on('error', () => undefined);

      const finish = (exitCode: number | null, spawnError?: Error) => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener('abort', onAbort);
        const durationMs = performance.now() - t0;
        stderr = redactCredentials(stderr);
        stdoutTail = redactCredentials(stdoutTail);
        const failed = !cancelled && (exitCode === null || !(opts.okExitCodes ?? [0]).includes(exitCode));
        listener?.onCommandEnd?.({ ...start, durationMs, exitCode, stderr, stdoutTail, cancelled, failed });
        if (spawnError) {
          reject(new GitError(start.args, null, spawnError.message, '', { kind: 'spawnFailed', files: [] }));
        } else if (cancelled) {
          reject(new GitError(start.args, exitCode, 'Cancelled', '', { kind: 'cancelled', files: [] }));
        } else if (exitCode === null || !(opts.okExitCodes ?? [0]).includes(exitCode)) {
          reject(new GitError(start.args, exitCode, stderr, stdoutTail));
        } else {
          resolve({ stderr, exitCode, durationMs });
        }
      };

      child.on('error', (error) => finish(null, error));
      child.on('close', (code) => finish(code));

      if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
      else child.stdin.end();
    });
  }
}
