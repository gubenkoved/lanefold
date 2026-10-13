import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Platform,
  PlatformDiff,
  PlatformMerge,
  PlatformMultiDiff,
} from '../../src/core/backend/platform';
import type { Repository } from '../../src/core/repo/repository';
import type { Disposable } from '../../src/core/util/emitter';
import { DEFAULT_SETTINGS, type Settings } from '../../src/shared/models';
import type { HostCommand } from '../../src/shared/protocol';

/** A diff the webview asked the host to open (single file or multi-file). */
export interface OpenedDiff {
  /** The repository (its root). */
  readonly repo?: string;
  readonly title: string;
  readonly left?: string;
  readonly right?: string;
  readonly base?: string;
  readonly target?: string;
  readonly files?: readonly string[];
}

/** Platform for the browser dev harness: default settings, in-memory storage, no host UI. */
export class HarnessPlatform implements Platform {
  readonly kind = 'harness' as const;
  private readonly storage = new Map<string, unknown>();

  /** Diffs requested by the webview (the harness has no editor; e2e tests inspect this list). */
  readonly openedDiffs: OpenedDiff[] = [];

  constructor(
    private readonly settings: Settings = DEFAULT_SETTINGS,
    readonly logWorkerPath?: string,
    readonly sequenceEditorPath?: string,
  ) {}

  async openDiff({ repo, title, left, right }: PlatformDiff): Promise<void> {
    this.openedDiffs.push({
      repo: repo.root,
      title,
      left: left && `${left.rev}:${left.path}`,
      right: right && `${right.rev}:${right.path}`,
    });
    console.log(
      `[harness] open diff "${title}": ${left?.rev ?? '∅'}:${left?.path ?? ''} ↔ ${right?.rev ?? '∅'}:${right?.path ?? ''}`,
    );
  }

  async openMultiDiff({ repo, title, files, base, target }: PlatformMultiDiff): Promise<void> {
    this.openedDiffs.push({ repo: repo.root, title, base, target, files: files.map((file) => file.path) });
    console.log(`[harness] open multi-diff "${title}" (${files.length} files)`);
  }

  async openMergeEditor({ path, current, incoming, hasBase }: PlatformMerge): Promise<boolean> {
    this.openedDiffs.push({
      title: `merge ${path}: ${current.title} ↔ ${incoming.title}`,
      left: ':2:' + path,
      right: ':3:' + path,
      base: hasBase ? ':1:' + path : undefined,
    });
    return true;
  }

  async openFile(_repo: Repository, path: string, rev?: string): Promise<void> {
    this.openedDiffs.push({ title: `open ${path}`, right: `${rev ?? 'WORKTREE'}:${path}` });
  }

  /** Files the webview saved (the harness writes them to a temporary folder). */
  readonly savedFiles: string[] = [];
  /** What the next file pick returns (e2e tests set it through /debug/pick). */
  nextPick: string | undefined;

  async saveFile(_repo: Repository, suggestedName: string, content: Uint8Array): Promise<string | undefined> {
    const folder = mkdtempSync(join(tmpdir(), 'lanefold-harness-save-'));
    const file = join(folder, suggestedName.replace(/[\\/]/g, '-'));
    writeFileSync(file, content);
    this.savedFiles.push(file);
    return file;
  }

  async pickFile(): Promise<string | undefined> {
    const picked = this.nextPick;
    this.nextPick = undefined;
    return picked;
  }

  /** Registers and watches another repository in the session (the server sets this up). */
  opener: ((folder: string) => Promise<Repository | undefined>) | undefined;

  async openRepository(folder: string): Promise<Repository | undefined> {
    return this.opener?.(folder);
  }

  getSettings(): Settings {
    return this.settings;
  }

  onDidChangeSettings(): Disposable {
    return { dispose: () => undefined };
  }

  storageGet(key: string): unknown {
    return this.storage.get(key);
  }

  async storageSet(key: string, value: unknown): Promise<void> {
    this.storage.set(key, value);
  }

  /** Host commands the webview asked for (e2e tests read them). */
  readonly commands: { command: HostCommand; args?: unknown }[] = [];
  /** What the webview last reported about focus (VS Code sets `lanefold.graphFocused` from it). */
  focus: { focused: boolean; graphFocused: boolean } | undefined;

  async runCommand(command: HostCommand, args?: unknown): Promise<void> {
    this.commands.push({ command, args });
    console.log(`[harness] host command requested: ${command}`);
  }
}
