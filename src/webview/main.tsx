import '@vscode/codicons/dist/codicon.css';
import './styles/tokens.css';
import './styles/base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connectHost } from './bridge/host';
import { HostContext } from './hostContext';
import { connectOperations, redo, undo, whenActive } from './state/operations';
import {
  editorShowing,
  rebaseInteractively,
  redoArrangement,
  undoArrangement,
  useRewrite,
} from './state/rewrite';
import { connectStore, tabsLoaded, useApp } from './state/store';

const host = connectHost();
host.rpc.emit('ui.ready', {});
void connectStore(host);
connectOperations();

// Undo and Redo from VS Code (the command palette, Ctrl+Z in the graph): while the history
// editor shows, they step through its arrangement, as its own keys do; git's Undo waits.
host.rpc.on('command.run', ({ command, args }) => {
  // Rebase Interactively onto…, its target picked in VS Code: the history editor opens on it.
  if (command === 'startRebaseOnto') {
    const { repoId, onto } = (args ?? {}) as { repoId?: unknown; onto?: unknown };
    if (typeof repoId !== 'string' || typeof onto !== 'string') return;
    void whenActive(repoId)
      .then((active) => (active ? tabsLoaded().then(() => true) : false))
      .then((ready) => ready && void rebaseInteractively(onto));
    return;
  }
  if (command !== 'undo' && command !== 'redo') return;
  if (editorShowing()) (command === 'undo' ? undoArrangement : redoArrangement)();
  else void (command === 'undo' ? undo() : redo());
});

/**
 * Where Ctrl+Z belongs to the focused element rather than to Lanefold's git Undo: text being
 * typed, and views with an undo of their own (the history editor).
 */
const OWN_UNDO = [
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="range"]):not([type="color"]):not([type="file"])',
  '[data-own-undo]',
].join(', ');

// Report focus: VS Code runs host commands in the focused view and scopes Lanefold's shortcuts
// with `lanefold.graphFocused`. Checked once focus settles (blur and focus come in pairs). While
// the history editor shows, Ctrl+Z is never git's, wherever focus is.
let reported = '';
let pending: ReturnType<typeof setTimeout> | undefined;
const reportFocus = () => {
  clearTimeout(pending);
  pending = setTimeout(() => {
    const focused = document.hasFocus();
    const active = document.activeElement;
    const graphFocused =
      focused && !editorShowing() && !(active instanceof Element && active.closest(OWN_UNDO));
    const key = `${focused}:${graphFocused}`;
    if (key === reported) return;
    reported = key;
    host.rpc.emit('ui.focus', { focused, graphFocused });
  });
};
window.addEventListener('focus', reportFocus);
window.addEventListener('blur', reportFocus);
document.addEventListener('focusin', reportFocus);
document.addEventListener('focusout', reportFocus);
// The editor opens and closes (or its tab is switched to) without focus moving.
let showing = false;
const reportEditor = () => {
  if (editorShowing() === showing) return;
  showing = !showing;
  reportFocus();
};
useRewrite.subscribe(reportEditor);
useApp.subscribe(reportEditor);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HostContext.Provider value={host}>
      <App />
    </HostContext.Provider>
  </StrictMode>,
);
