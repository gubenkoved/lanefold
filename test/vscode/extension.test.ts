import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { LanefoldExtensionApi } from '../../src/extension/extension';

async function waitFor<T>(
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function api(): Promise<LanefoldExtensionApi> {
  const extension = vscode.extensions.getExtension<LanefoldExtensionApi>('EugeneGubenkov.lanefold-git');
  assert.ok(extension, 'extension is installed');
  const exports = extension.isActive ? extension.exports : await extension.activate();
  await exports.ready;
  return exports;
}

suite('Lanefold', () => {
  test('activates in a trusted git workspace and discovers the repository', async () => {
    const { testing } = await api();
    assert.ok(testing, 'test hooks are exported in test mode');
    const repos = await waitFor(() =>
      testing.repositories().length > 0 ? testing.repositories() : undefined,
    );
    assert.ok(
      repos.some((root) => root.endsWith('aurora')),
      `found ${repos.join(', ')}`,
    );
  });

  test('opens the panel and the webview connects over RPC', async () => {
    const { testing } = await api();
    await vscode.commands.executeCommand('lanefold.open');
    await waitFor(() => testing!.readyWebviews() > 0);
    const theme = await testing!.captureTheme();
    assert.ok(Object.keys(theme.variables).length > 100, 'VS Code injected its theme variables');
    assert.match(theme.bodyClass, /vscode-(dark|light|high-contrast)/);
    // The webview loaded the repository state through the backend.
    await waitFor(() => testing!.consoleHistory().some((entry) => entry.args.includes('symbolic-ref')));
  });

  test('registers every command it contributes', async () => {
    await api();
    const extension = vscode.extensions.getExtension('EugeneGubenkov.lanefold-git')!;
    const declared = (extension.packageJSON as { contributes: { commands: { command: string }[] } })
      .contributes.commands;
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = declared.map((entry) => entry.command).filter((command) => !registered.has(command));
    assert.deepEqual(missing, []);
  });

  test('line history opens a view of the commits that changed the selected lines', async () => {
    const { testing } = await api();
    const repo = await waitFor(() => testing!.repositories().find((root) => root.endsWith('aurora')));
    const document = await vscode.workspace.openTextDocument(join(repo, 'src', 'forecast.ts'));
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 4, 0);
    await vscode.commands.executeCommand('lanefold.lineHistory');
    // The webview loads the view: git log -L over the selected lines (1–4).
    await waitFor(() =>
      testing!.consoleHistory().some((entry) => entry.args.some((arg) => arg === '-L1,4:src/forecast.ts')),
    );
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('pops a view out into an editor tab, titled after the view it shows', async () => {
    const { testing } = await api();
    const before = testing!.readyWebviews();
    await vscode.commands.executeCommand('lanefold.openInEditor');
    await waitFor(() => testing!.readyWebviews() > before);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputWebview);
    assert.ok((tab.input as vscode.TabInputWebview).viewType.endsWith('lanefold.editor'));
    // "Lanefold" until the webview names the view it shows.
    const title = await waitFor(() => {
      const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label;
      return label !== 'Lanefold' && label;
    });
    assert.ok(title.length > 0);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  /**
   * With LANEFOLD_SCREENSHOTS=<dir>, saves what the (virtual) screen shows, `settleMs` after what
   * just changed (annotations, an editor) for it to render. Without it, does nothing.
   */
  async function screenshot(name: string, settleMs = 0): Promise<void> {
    const target = process.env.LANEFOLD_SCREENSHOTS;
    if (!target) return;
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    mkdirSync(target, { recursive: true });
    // Test-run noise (running as root, extensions disabled) and the chat sidebar stay out.
    await vscode.commands.executeCommand('notifications.clearAll');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      execFileSync('import', ['-window', 'root', join(target, `${name}.png`)]);
    } catch {
      // No X screenshot tool here; the assertions are what matter.
    }
  }

  test('annotates a file with blame and steps back through a line’s history', async () => {
    const { testing } = await api();
    await waitFor(() => testing!.repositories().length > 0);
    const folder = vscode.workspace.workspaceFolders![0]!.uri;
    const file = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'src', 'forecast.ts'));
    await vscode.window.showTextDocument(file, { preview: false });
    await vscode.commands.executeCommand('lanefold.blame.show');
    const blame = await waitFor(() => testing!.blame(file.uri.toString()));
    // VS Code counts the empty line after a final newline; git does not.
    assert.ok(blame.lines === file.lineCount || blame.lines === file.lineCount - 1);
    const line = blame.summaries.indexOf('Polish dashboard layout');
    assert.ok(line >= 0, `a line from "Polish dashboard layout": ${blame.summaries.join(' | ')}`);
    await screenshot('blame-file', 1000);
    if (process.env.LANEFOLD_SCREENSHOTS) {
      // The hover over the annotation (it sits before the first character of the line).
      const editor = vscode.window.activeTextEditor!;
      editor.selection = new vscode.Selection(line, 0, line, 0);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await vscode.commands.executeCommand('editor.action.showHover');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await screenshot('blame-hover');
      await vscode.commands.executeCommand('editor.action.hideHover');
    }

    // The file as it was before that commit, at the same line, annotated too: there the line
    // still comes from the commit that wrote the function.
    await vscode.commands.executeCommand('lanefold.blame.annotatePrevious', {
      uri: file.uri.toString(),
      line,
    });
    const previous = await waitFor(() => {
      const editor = vscode.window.activeTextEditor;
      return editor?.document.uri.scheme === 'lanefold' ? editor : undefined;
    });
    assert.match(previous.document.uri.query, /"rev":"[0-9a-f]{40}"/);
    const before = await waitFor(() => testing!.blame(previous.document.uri.toString()));
    assert.equal(before.summaries[previous.selection.active.line], 'Add forecast API client');
    await screenshot('blame-previous', 1000);

    await vscode.commands.executeCommand('lanefold.blame.back');
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === file.uri.toString());
    assert.equal(vscode.window.activeTextEditor!.selection.active.line, line);
    await vscode.commands.executeCommand('lanefold.blame.hide');
    await waitFor(() => !testing!.blame(file.uri.toString()));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('a diff against the index follows the index: staging updates the open document', async () => {
    const { testing } = await api();
    const root = await waitFor(() => testing!.repositories().find((repo) => repo.endsWith('aurora')));
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    const relative = 'README.md';
    const original = git('show', `:${relative}`);
    const uri = vscode.Uri.file(join(root, relative)).with({
      scheme: 'lanefold',
      query: JSON.stringify({ repo: root, rev: 'INDEX', path: relative, ref: 'Index' }),
    });
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    assert.equal(document.getText(), original);
    try {
      writeFileSync(join(root, relative), `${original}Staged from the test.\n`);
      git('add', relative);
      await waitFor(() => document.getText().includes('Staged from the test.'));
    } finally {
      writeFileSync(join(root, relative), original);
      git('add', relative);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  // Writes the exact theme variables VS Code injects into webviews, so the browser harness
  // (Playwright e2e, screenshots) renders with real themes. Run with LANEFOLD_CAPTURE_THEMES=<dir>.
  test('captures harness theme snapshots', async function () {
    const target = process.env.LANEFOLD_CAPTURE_THEMES;
    if (!target) this.skip();
    this.timeout(120_000);
    const { testing } = await api();
    await vscode.commands.executeCommand('lanefold.open');
    await waitFor(() => testing!.readyWebviews() > 0);
    const themes: Record<string, string> = {
      'dark-modern': 'Default Dark Modern',
      'light-modern': 'Default Light Modern',
      'dark-hc': 'Default High Contrast',
      'light-hc': 'Default High Contrast Light',
    };
    const config = vscode.workspace.getConfiguration('workbench');
    mkdirSync(target!, { recursive: true });
    for (const [file, themeName] of Object.entries(themes)) {
      await config.update('colorTheme', themeName, vscode.ConfigurationTarget.Global);
      const snapshot = await waitFor(async () => {
        const captured = await testing!.captureTheme();
        const background = captured.variables['--vscode-editor-background'];
        // Wait until the webview reflects the new theme.
        return captured.themeKind && background ? captured : undefined;
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const settled = await testing!.captureTheme();
      writeFileSync(join(target!, `${file}.json`), JSON.stringify({ ...settled, themeName }, null, 2) + '\n');
      assert.ok(Object.keys(snapshot.variables).length > 100);
    }
    await config.update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
  });
});
