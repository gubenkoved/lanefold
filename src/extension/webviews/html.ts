import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Bootstrap } from '../../shared/protocol';

function nonce(): string {
  return randomBytes(16).toString('base64');
}

/** JSON safe to embed inside a <script> element. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
      vscode.Uri.joinPath(extensionUri, 'media'),
    ],
  };
}

/**
 * The webview page: a strict, nonce-based CSP; the Vite bundle (main.js/main.css, plus lazily
 * loaded chunks from the same origin); and the bootstrap data as an inert JSON script.
 */
export function renderWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  bootstrap: Bootstrap,
  options: { gravatar?: boolean } = {},
): string {
  const scriptNonce = nonce();
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.css'));
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${scriptNonce}' ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:${options.gravatar ? ' https://www.gravatar.com' : ''}`,
    'worker-src blob:',
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
  <title>Lanefold</title>
</head>
<body>
  <div id="root"></div>
  <script id="lanefold-bootstrap" type="application/json" nonce="${scriptNonce}">${embedJson(bootstrap)}</script>
  <script type="module" nonce="${scriptNonce}" src="${script}"></script>
</body>
</html>`;
}
