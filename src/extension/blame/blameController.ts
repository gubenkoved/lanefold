import * as path from 'node:path';
import * as vscode from 'vscode';
import { blameFile, commitMessage, previousLine } from '../../core/blame/blame';
import { GitError } from '../../core/git/errors';
import type { RepositoryRegistry } from '../../core/repo/registry';
import type { Repository } from '../../core/repo/repository';
import { short } from '../../core/util/wording';
import { blameBlocks, type BlameCommit, type BlameResult } from '../../shared/blame';
import { isObjectId } from '../../shared/oid';
import { absoluteTime, relativeLong, relativeTime } from '../../shared/time';
import { locateFile } from '../fileLocation';
import { EMPTY_REVISION, parseRevisionUri, REVISION_SCHEME, revisionUri } from '../revisionFs';
import { heatColors, heatScale, type HeatColors } from './heat';

/** What a document's blame is computed for. */
interface Target {
  readonly repo: Repository;
  /** Repository-relative path, forward slashes. */
  readonly path: string;
  /** Commit the document shows; undefined for the working tree file. */
  readonly rev?: string;
}

interface DocumentBlame {
  readonly target: Target;
  result?: BlameResult;
  loading?: AbortController;
  error?: string;
}

interface Location {
  readonly uri: vscode.Uri;
  readonly line: number;
}

/** Width of the annotation column, in editor characters. */
const WIDTH = 28;
/** Distinct shades of the age heat (each a decoration type, shared by every editor). */
const HEAT_STEPS = 10;
const NBSP = ' ';

const COMMANDS = {
  toggle: 'lanefold.blame.toggle',
  show: 'lanefold.blame.show',
  hide: 'lanefold.blame.hide',
  previous: 'lanefold.blame.annotatePrevious',
  back: 'lanefold.blame.back',
  forward: 'lanefold.blame.forward',
  showCommit: 'lanefold.blame.showCommit',
  openChanges: 'lanefold.blame.openChanges',
  copyHash: 'lanefold.blame.copyHash',
} as const;

const key = (uri: vscode.Uri) => uri.toString();

function themeKind(): 'dark' | 'light' {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark';
}

function commandLink(command: string, args: unknown): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([args]))}`;
}

/**
 * The annotation column's look as a fixed set of decoration types (per heat shade, for a block's
 * first line and the lines after it): editors then only get ranges, plus each block's text.
 */
interface Styles {
  readonly theme: 'dark' | 'light';
  readonly first: readonly vscode.TextEditorDecorationType[];
  readonly rest: readonly vscode.TextEditorDecorationType[];
  readonly uncommittedFirst: vscode.TextEditorDecorationType;
  readonly uncommittedRest: vscode.TextEditorDecorationType;
  readonly all: readonly vscode.TextEditorDecorationType[];
}

function createStyles(theme: 'dark' | 'light'): Styles {
  const make = (colors: HeatColors, first: boolean, uncommitted: boolean) =>
    vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
      before: {
        // A block's first line gets its text per line; the others are blank.
        contentText: first ? undefined : NBSP,
        color: new vscode.ThemeColor(first ? 'editorCodeLens.foreground' : 'editorLineNumber.foreground'),
        // Otherwise the annotation takes the style of the line's first token (italic keywords).
        fontStyle: uncommitted ? 'italic' : 'normal',
        fontWeight: 'normal',
        textDecoration: [
          'none',
          'display: inline-block',
          `width: ${WIDTH}ch`,
          'box-sizing: border-box',
          'padding: 0 1ch 0 0.8ch',
          'margin-right: 1.5ch',
          `border-left: 3px ${uncommitted ? 'dotted' : 'solid'} ${colors.bar}`,
          // The tint over the editor's own background: opaque, so nothing VS Code draws under
          // the text shows through (an empty line's indent guide is placed as if the
          // annotation were not there).
          `background: linear-gradient(${colors.background}, ${colors.background}), var(--vscode-editor-background)`,
          'overflow: hidden',
          'text-overflow: ellipsis',
          'white-space: pre',
          'vertical-align: top',
        ].join('; '),
      },
    });
  const shades = Array.from({ length: HEAT_STEPS }, (_, step) => heatColors(step / (HEAT_STEPS - 1), theme));
  const uncommitted = { bar: 'var(--vscode-editorGutter-modifiedBackground)', background: 'transparent' };
  const first = shades.map((colors) => make(colors, true, false));
  const rest = shades.map((colors) => make(colors, false, false));
  const uncommittedFirst = make(uncommitted, true, true);
  const uncommittedRest = make(uncommitted, false, true);
  return {
    theme,
    first,
    rest,
    uncommittedFirst,
    uncommittedRest,
    all: [...first, ...rest, uncommittedFirst, uncommittedRest],
  };
}

/**
 * Blame annotations in editors, PyCharm style: who last changed each line and when, with an age
 * heat bar, rich hovers, and "Annotate Previous Revision" to step back through a line's history
 * (with Back/Forward).
 */
export class BlameController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** Annotated documents, by URI string. */
  private readonly enabled = new Map<string, vscode.Uri>();
  private readonly documents = new Map<string, DocumentBlame>();
  private readonly messages = new Map<string, string>();
  private styles = createStyles(themeKind());
  /** What each editor shows (editors are new objects whenever they are shown again). */
  private rendered = new WeakMap<vscode.TextEditor, BlameResult | undefined>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
  private readonly backStack: Location[] = [];
  private readonly forwardStack: Location[] = [];
  private readonly changeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly registry: RepositoryRegistry,
    private readonly revealCommit: (repo: Repository, sha: string) => Promise<void>,
    /** Resolves once the workspace's repositories are known. */
    private readonly whenReady: () => Promise<void> = () => Promise.resolve(),
  ) {
    const command = (id: string, run: (...args: never[]) => unknown) =>
      this.disposables.push(vscode.commands.registerCommand(id, run));
    command(COMMANDS.toggle, (uri?: vscode.Uri) => this.toggle(uri));
    command(COMMANDS.show, (uri?: vscode.Uri) => this.setEnabled(uri, true));
    command(COMMANDS.hide, (uri?: vscode.Uri) => this.setEnabled(uri, false));
    command(COMMANDS.previous, (args?: { uri?: string; line?: number }) => this.annotatePrevious(args));
    command(COMMANDS.back, () => this.travel('back'));
    command(COMMANDS.forward, () => this.travel('forward'));
    command(COMMANDS.showCommit, (args?: { repo: string; sha: string }) => this.showCommit(args));
    command(COMMANDS.openChanges, (args?: { repo: string; sha: string; path: string }) =>
      this.openChanges(args),
    );
    command(COMMANDS.copyHash, async (args?: { sha: string }) => {
      if (!args?.sha) return;
      await vscode.env.clipboard.writeText(args.sha);
      void vscode.window.setStatusBarMessage(`$(check) Copied ${short(args.sha)}`, 2000);
    });

    this.disposables.push(
      { dispose: () => this.styles.all.forEach((type) => type.dispose()) },
      this.status,
      vscode.languages.registerHoverProvider([{ scheme: 'file' }, { scheme: 'lanefold' }], {
        provideHover: (document, position, token) => this.hover(document, position, token),
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      // Editors that were just shown (the others keep their decorations).
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) this.render(editor);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => this.scheduleStatus(event.textEditor)),
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (themeKind() === this.styles.theme) return;
        for (const type of this.styles.all) type.dispose();
        this.styles = createStyles(themeKind());
        this.rendered = new WeakMap();
        for (const editor of vscode.window.visibleTextEditors) this.render(editor);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        // Saving flips the dirty flag with no change to the text.
        if (event.contentChanges.length > 0) this.onEdit(event.document);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => this.reload(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.forget(document.uri)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('lanefold.blame'))
          for (const doc of this.openDocuments()) this.reload(doc);
      }),
      registry.onDidChangeRepo(({ repo, kinds }) => {
        // A commit, checkout or reset changes what the working tree files' lines are blamed on.
        if (!kinds.has('head') && !kinds.has('refs') && !kinds.has('index')) return;
        for (const document of this.openDocuments()) {
          const state = this.documents.get(key(document.uri));
          if (state && !state.target.rev && state.target.repo === repo) this.reload(document);
        }
      }),
    );
    this.updateContext();
  }

  // ---- enabling --------------------------------------------------------------------------

  private editorFor(uri?: vscode.Uri): vscode.TextEditor | undefined {
    if (!uri) return vscode.window.activeTextEditor;
    return vscode.window.visibleTextEditors.find((editor) => key(editor.document.uri) === key(uri));
  }

  private toggle(uri?: vscode.Uri): Promise<void> {
    const editor = this.editorFor(uri);
    if (!editor) return Promise.resolve();
    return this.setEnabled(editor.document.uri, !this.enabled.has(key(editor.document.uri)));
  }

  /** Drops a document's annotations and everything kept for it. */
  private forget(uri: vscode.Uri): void {
    const id = key(uri);
    this.enabled.delete(id);
    this.documents.get(id)?.loading?.abort();
    this.documents.delete(id);
    clearTimeout(this.changeTimers.get(id));
    this.changeTimers.delete(id);
  }

  private async setEnabled(uri: vscode.Uri | undefined, on: boolean): Promise<void> {
    const editor = this.editorFor(uri);
    if (!editor) return;
    const document = editor.document;
    const id = key(document.uri);
    if (!on) {
      this.forget(document.uri);
      for (const visible of vscode.window.visibleTextEditors)
        if (key(visible.document.uri) === id) this.render(visible);
      this.updateContext();
      return;
    }
    // Files are matched to repositories once those are discovered.
    await this.whenReady();
    const target = this.targetOf(document);
    if (typeof target === 'string') {
      void vscode.window.showInformationMessage(`Lanefold blame: ${target}`);
      return;
    }
    this.enabled.set(id, document.uri);
    this.documents.set(id, { target });
    this.updateContext();
    await this.load(document);
  }

  /** Where a document's content comes from, or why it cannot be blamed. */
  private targetOf(document: vscode.TextDocument): Target | string {
    const uri = document.uri;
    const revision = parseRevisionUri(uri);
    if (revision) {
      if (revision.rev === EMPTY_REVISION || revision.rev === 'INDEX')
        return 'only commits and working tree files can be annotated.';
      const repo = this.registry.get(revision.repo);
      return repo ? { repo, path: revision.path, rev: revision.rev } : 'its repository is not open.';
    }
    if (uri.scheme !== 'file') return 'only files and file revisions can be annotated.';
    const location = locateFile(this.registry, uri);
    if (!location || !location.path) return 'this file is not in a git repository Lanefold knows.';
    return { repo: location.repo, path: location.path };
  }

  private openDocuments(): vscode.TextDocument[] {
    return vscode.workspace.textDocuments.filter((document) => this.enabled.has(key(document.uri)));
  }

  // ---- computing ---------------------------------------------------------------------------

  private onEdit(document: vscode.TextDocument): void {
    const id = key(document.uri);
    if (!this.enabled.has(id)) return;
    // Lines typed since the last blame have no annotation until the next one (per document: a
    // replace across files re-blames each of them).
    clearTimeout(this.changeTimers.get(id));
    this.changeTimers.set(
      id,
      setTimeout(() => {
        this.changeTimers.delete(id);
        this.reload(document);
      }, 700),
    );
  }

  private reload(document: vscode.TextDocument): void {
    if (this.enabled.has(key(document.uri))) void this.load(document);
  }

  private async load(document: vscode.TextDocument): Promise<void> {
    const state = this.documents.get(key(document.uri));
    if (!state) return;
    state.loading?.abort();
    const controller = new AbortController();
    state.loading = controller;
    const settings = vscode.workspace.getConfiguration('lanefold.blame');
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Blame' },
        () =>
          blameFile(state.target.repo, state.target.path, {
            rev: state.target.rev,
            contents: !state.target.rev && document.isDirty ? document.getText() : undefined,
            ignoreWhitespace: settings.get('ignoreWhitespace', false),
            detectMoves: settings.get('detectMoves', false),
            signal: controller.signal,
          }),
      );
      if (controller.signal.aborted) return;
      state.result = result;
      state.error = undefined;
    } catch (error) {
      if (controller.signal.aborted) return;
      state.error = describeFailure(error);
      this.forget(document.uri);
      this.updateContext();
      void vscode.window.showWarningMessage(`Lanefold blame: ${state.error}`);
    } finally {
      if (state.loading === controller) state.loading = undefined;
    }
    for (const editor of vscode.window.visibleTextEditors)
      if (key(editor.document.uri) === key(document.uri)) this.render(editor);
    this.scheduleStatus(vscode.window.activeTextEditor);
  }

  // ---- rendering ---------------------------------------------------------------------------

  /** Shows a document's annotations in an editor, unless it already shows them. */
  private render(editor: vscode.TextEditor): void {
    const id = key(editor.document.uri);
    const result = this.enabled.has(id) ? this.documents.get(id)?.result : undefined;
    if (this.rendered.has(editor) ? this.rendered.get(editor) === result : !result) return;
    this.rendered.set(editor, result);
    const ranges = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();
    const add = (type: vscode.TextEditorDecorationType, option: vscode.DecorationOptions) => {
      const list = ranges.get(type);
      if (list) list.push(option);
      else ranges.set(type, [option]);
    };
    if (result) {
      const heat = heatScale(
        [...result.commits.values()].filter((c) => !c.uncommitted).map((c) => c.authorTime),
      );
      const lineCount = editor.document.lineCount;
      for (const block of blameBlocks(result)) {
        const commit = result.commits.get(block.sha);
        const step = commit ? Math.round(heat(commit.authorTime) * (HEAT_STEPS - 1)) : 0;
        const first = commit?.uncommitted ? this.styles.uncommittedFirst : this.styles.first[step]!;
        const rest = commit?.uncommitted ? this.styles.uncommittedRest : this.styles.rest[step]!;
        const text = commit ? annotationText(commit) : NBSP;
        for (let i = 0; i < block.length && block.start + i < lineCount; i++) {
          const range = new vscode.Range(block.start + i, 0, block.start + i, 0);
          if (i === 0) add(first, { range, renderOptions: { before: { contentText: text } } });
          else add(rest, { range });
        }
      }
    }
    for (const type of this.styles.all) editor.setDecorations(type, ranges.get(type) ?? []);
  }

  // ---- hover and status --------------------------------------------------------------------

  private lineInfo(document: vscode.TextDocument, line: number) {
    const state = this.documents.get(key(document.uri));
    const blamed = state?.result?.lines[line];
    const commit = blamed ? state?.result?.commits.get(blamed.sha) : undefined;
    return state && blamed && commit ? { state, blamed, commit } : undefined;
  }

  private async hover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    // Only over the annotation column (which sits before the first character).
    if (!this.enabled.has(key(document.uri)) || position.character > 0) return undefined;
    const info = this.lineInfo(document, position.line);
    if (!info) return undefined;
    const { state, commit } = info;
    const repo = state.target.repo;
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = { enabledCommands: Object.values(COMMANDS) };
    const lineArgs = { uri: document.uri.toString(), line: position.line };
    if (commit.uncommitted) {
      md.appendMarkdown(`$(circle-filled) **Not committed yet**\n\n`);
      md.appendMarkdown(
        `This line differs from \`${short(commit.previous?.sha ?? '')}\`.\n\n[$(history) Annotate the committed version](${commandLink(COMMANDS.previous, lineArgs)})`,
      );
      return new vscode.Hover(md);
    }
    let message = this.messages.get(commit.sha);
    if (message === undefined) {
      message = await commitMessage(repo, commit.sha).catch(() => commit.summary);
      if (token.isCancellationRequested) return undefined;
      this.messages.set(commit.sha, message);
      if (this.messages.size > 500) this.messages.delete(this.messages.keys().next().value as string);
    }
    const [subject, ...rest] = message.split('\n');
    const body = rest.join('\n').trim();
    md.appendMarkdown(`$(git-commit) **${escapeMarkdown(subject ?? commit.summary)}**\n\n`);
    md.appendMarkdown(
      `${escapeMarkdown(commit.author)} \\<${escapeMarkdown(commit.authorMail)}\\>, ${relativeLong(commit.authorTime)} · ${absoluteTime(commit.authorTime)}`,
    );
    if (commit.committer && commit.committer !== commit.author) {
      md.appendMarkdown(
        `  \ncommitted by ${escapeMarkdown(commit.committer)}, ${relativeLong(commit.committerTime)}`,
      );
    }
    if (body)
      md.appendMarkdown(`\n\n${escapeMarkdown(body.length > 1200 ? `${body.slice(0, 1200)}…` : body)}`);
    if (commit.filename !== state.target.path)
      md.appendMarkdown(
        `\n\n$(arrow-right) In this commit the file was \`${escapeMarkdown(commit.filename)}\`.`,
      );
    const commitArgs = { repo: repo.id, sha: commit.sha, path: commit.filename };
    const actions = [
      `[$(eye) Show in graph](${commandLink(COMMANDS.showCommit, commitArgs)} "Select this commit in Lanefold")`,
      `[$(diff) Changes](${commandLink(COMMANDS.openChanges, commitArgs)} "What this commit changed in the file")`,
      commit.previous
        ? `[$(history) Annotate previous revision](${commandLink(COMMANDS.previous, lineArgs)} "Blame the file as it was before this commit, at this line")`
        : '$(history) _added in this commit_',
      `[$(copy) ${short(commit.sha)}](${commandLink(COMMANDS.copyHash, { sha: commit.sha })} "Copy the full hash")`,
    ];
    md.appendMarkdown(`\n\n---\n\n${actions.join(' &nbsp;·&nbsp; ')}`);
    return new vscode.Hover(md);
  }

  private scheduleStatus(editor: vscode.TextEditor | undefined): void {
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.updateStatus(editor), 60);
  }

  private updateStatus(editor: vscode.TextEditor | undefined): void {
    const info =
      editor && this.enabled.has(key(editor.document.uri))
        ? this.lineInfo(editor.document, editor.selection.active.line)
        : undefined;
    if (!info) {
      this.status.hide();
      return;
    }
    const { commit, state } = info;
    if (commit.uncommitted) {
      this.status.text = '$(git-commit) Not committed yet';
      this.status.tooltip = undefined;
      this.status.command = undefined;
    } else {
      this.status.text = `$(git-commit) ${commit.author}, ${relativeLong(commit.authorTime)}`;
      this.status.tooltip = `${commit.summary}\n${short(commit.sha)} · click to show it in Lanefold`;
      this.status.command = {
        title: 'Show in Lanefold',
        command: COMMANDS.showCommit,
        arguments: [{ repo: state.target.repo.id, sha: commit.sha }],
      };
    }
    this.status.show();
  }

  /**
   * Context keys for menus and shortcuts. Which documents are annotated is a list, so each
   * editor group's title shows the right Show/Hide button (`resourcePath in …`).
   */
  private updateContext(): void {
    const annotated = [...this.enabled.values()];
    const set = (name: string, value: unknown) =>
      void vscode.commands.executeCommand('setContext', name, value);
    set(
      'lanefold.blame.files',
      annotated.filter((uri) => uri.scheme === 'file').map((uri) => uri.fsPath),
    );
    set(
      'lanefold.blame.revisions',
      annotated.filter((uri) => uri.scheme === REVISION_SCHEME).map((uri) => uri.fsPath),
    );
    set('lanefold.blame.canGoBack', this.backStack.length > 0);
    set('lanefold.blame.canGoForward', this.forwardStack.length > 0);
    this.scheduleStatus(vscode.window.activeTextEditor);
  }

  // ---- annotate previous and navigation ----------------------------------------------------

  private async annotatePrevious(args?: { uri?: string; line?: number }): Promise<void> {
    await this.whenReady();
    const editor = this.editorFor(args?.uri ? vscode.Uri.parse(args.uri) : undefined);
    if (!editor) return;
    const line = args?.line ?? editor.selection.active.line;
    if (!this.enabled.has(key(editor.document.uri))) await this.setEnabled(editor.document.uri, true);
    const info = this.lineInfo(editor.document, line);
    if (!info) return;
    const { state, blamed, commit } = info;
    const repo = state.target.repo;
    if (!commit.previous) {
      const choice = await vscode.window.showInformationMessage(
        `This line was added in ${short(commit.sha)} “${commit.summary}”: there is no earlier version of it.`,
        'Show in graph',
      );
      if (choice) await this.showCommit({ repo: repo.id, sha: commit.sha });
      return;
    }
    const unsaved = !state.target.rev && editor.document.isDirty ? editor.document.getText() : undefined;
    const target = await previousLine(repo, commit, blamed.origLine, state.target.path, unsaved);
    if (!target) return;
    this.backStack.push({ uri: editor.document.uri, line });
    this.forwardStack.length = 0;
    await this.open(
      { uri: revisionUri(repo, { rev: target.sha, path: target.path }), line: target.line - 1 },
      editor,
    );
  }

  private async travel(direction: 'back' | 'forward'): Promise<void> {
    const from = direction === 'back' ? this.backStack : this.forwardStack;
    const to = direction === 'back' ? this.forwardStack : this.backStack;
    const location = from.pop();
    if (!location) return;
    const editor = vscode.window.activeTextEditor;
    if (editor) to.push({ uri: editor.document.uri, line: editor.selection.active.line });
    await this.open(location, editor);
  }

  /** Opens a location with blame on, in the same editor group. */
  private async open(location: Location, from: vscode.TextEditor | undefined): Promise<void> {
    const document = await vscode.workspace.openTextDocument(location.uri);
    const position = new vscode.Position(Math.min(location.line, document.lineCount - 1), 0);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: from?.viewColumn,
      preview: true,
      selection: new vscode.Selection(position, position),
    });
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
    if (!this.enabled.has(key(document.uri))) await this.setEnabled(document.uri, true);
    this.updateContext();
  }

  private async showCommit(args?: { repo: string; sha: string }): Promise<void> {
    const repo = args && this.registry.get(args.repo);
    if (repo && args) await this.revealCommit(repo, args.sha);
  }

  private async openChanges(args?: { repo: string; sha: string; path: string }): Promise<void> {
    const repo = args && this.registry.get(args.repo);
    if (!repo || !args || !isObjectId(args.sha) || typeof args.path !== 'string') return;
    // The commit's own parent version (which may be a different path after a rename).
    const result = await repo.git(
      [
        'diff-tree',
        '-r',
        '-M',
        '--no-commit-id',
        '--name-status',
        '-z',
        '--root',
        '--end-of-options',
        args.sha,
      ],
      {
        readOnly: true,
        background: true,
        label: 'Changes of the commit',
      },
    );
    const tokens = result.stdout.split('\0').filter(Boolean);
    let oldPath: string | undefined = args.path;
    let added = false;
    for (let i = 0; i < tokens.length; i++) {
      const status = tokens[i]!;
      if (status.startsWith('R') || status.startsWith('C')) {
        if (tokens[i + 2] === args.path) oldPath = tokens[i + 1];
        i += 2;
      } else {
        if (tokens[i + 1] === args.path && status === 'A') added = true;
        i += 1;
      }
    }
    const left = added
      ? revisionUri(repo, { rev: EMPTY_REVISION, path: args.path })
      : revisionUri(repo, { rev: `${args.sha}^`, path: oldPath ?? args.path });
    const right = revisionUri(repo, { rev: args.sha, path: args.path });
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${path.posix.basename(args.path)} (${short(args.sha)})`,
      { preview: true },
    );
  }

  /** For integration tests: what is annotated in a document. */
  inspect(uri: string): { lines: number; summaries: string[] } | undefined {
    const result = this.enabled.has(uri) ? this.documents.get(uri)?.result : undefined;
    if (!result) return undefined;
    return {
      lines: result.lines.length,
      summaries: result.lines.map((line) => result.commits.get(line.sha)?.summary ?? ''),
    };
  }

  dispose(): void {
    for (const timer of this.changeTimers.values()) clearTimeout(timer);
    clearTimeout(this.statusTimer);
    for (const state of this.documents.values()) state.loading?.abort();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

/** "Mar 4, 2024  Alice Archer" — date first, aligned, so the column reads like a timeline. */
function annotationText(commit: BlameCommit): string {
  const date = commit.uncommitted ? 'uncommitted' : relativeTime(commit.authorTime);
  return `${date}${NBSP.repeat(Math.max(1, 13 - date.length))}${commit.uncommitted ? 'you' : commit.author}`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (ch) => `\\${ch}`);
}

function describeFailure(error: unknown): string {
  if (error instanceof GitError) {
    if (/no such path/.test(error.stderr)) return 'this file is not committed yet.';
    if (/no such ref|bad revision|unknown revision/i.test(error.stderr))
      return 'that revision does not exist.';
    const line = error.stderr
      .split('\n')
      .map((l) => l.replace(/^(?:fatal|error): /, '').trim())
      .find(Boolean);
    return line ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
