import type { ChangedFile, DiffSide, Settings } from '../../shared/models';
import type { HostCommand } from '../../shared/protocol';
import type { Repository } from '../repo/repository';
import type { Disposable } from '../util/emitter';

export interface PlatformDiff {
  readonly repo: Repository;
  readonly title: string;
  readonly left?: DiffSide;
  readonly right?: DiffSide;
}

/** A conflicted file to resolve in a 3-way merge editor, with its sides named. */
export interface PlatformMerge {
  readonly repo: Repository;
  readonly path: string;
  readonly current: MergeSideLabel;
  readonly incoming: MergeSideLabel;
  /** Whether the index has the merge base (stage 1): files added on both sides have none. */
  readonly hasBase: boolean;
}

export interface MergeSideLabel {
  readonly title: string;
  readonly detail?: string;
}

export interface PlatformMultiDiff {
  readonly repo: Repository;
  readonly title: string;
  readonly files: readonly ChangedFile[];
  readonly base?: string;
  readonly target: string;
}

/**
 * Everything the backend needs from its host environment. The VS Code extension and the
 * browser dev harness each provide an implementation, so the backend logic is shared.
 */
export interface Platform {
  readonly kind: 'vscode' | 'harness';

  getSettings(): Settings;
  onDidChangeSettings(listener: (settings: Settings) => void): Disposable;

  /** Per-workspace persistent storage (tabs, layout, journal). */
  storageGet(key: string): unknown;
  storageSet(key: string, value: unknown): Promise<void>;

  /** Runs a host UI action requested by the webview. */
  runCommand(command: HostCommand, args?: unknown): Promise<void>;

  /** Opens a two-way diff in the host's diff editor. */
  openDiff(request: PlatformDiff): Promise<void>;
  /** Opens a multi-file diff (all changes of a commit, a range or a comparison). */
  openMultiDiff(request: PlatformMultiDiff): Promise<void>;
  /**
   * Opens a conflicted file in the host's 3-way merge editor. Resolves false when there is none
   * (the caller opens the file with its conflict markers instead).
   */
  openMergeEditor(request: PlatformMerge): Promise<boolean>;
  /** Opens a file in an editor: the working-tree file, or its content at `rev` (read-only). */
  openFile(repo: Repository, path: string, rev?: string): Promise<void>;
  /** Asks where to save `content` and writes it there; the path, or undefined if cancelled. */
  saveFile(repo: Repository, suggestedName: string, content: Uint8Array): Promise<string | undefined>;
  /** Asks the person to choose a file (a patch, say); its path, or undefined if cancelled. */
  pickFile(repo: Repository, title: string): Promise<string | undefined>;
  /** Opens a web page (an http or https URL) in the browser. */
  openExternal(url: string): Promise<void>;
  /**
   * Makes the repository at `folder` (a submodule or worktree of an open repository) one the
   * host knows: registered and watched like those it found itself. Undefined if there is none.
   */
  openRepository(folder: string): Promise<Repository | undefined>;

  /** Script that parses git history off the main thread (undefined: parse in-process). */
  readonly logWorkerPath?: string;
  /** Lanefold's rebase sequence editor script (history editing is unavailable without it). */
  readonly sequenceEditorPath?: string;
}
