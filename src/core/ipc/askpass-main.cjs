#!/usr/bin/env node
/*
 * Lanefold's askpass helper: git (GIT_ASKPASS) and ssh (SSH_ASKPASS) run it with a prompt such
 * as "Password for 'https://alice@example.com': ". It asks Lanefold over a private socket and
 * prints the answer; it exits with an error when the user cancels, so git stops cleanly.
 *
 * Plain CommonJS on purpose: it runs under `node` (or VS Code's Electron in node mode) as is.
 */
'use strict';

const http = require('http');

const handle = process.env.LANEFOLD_ASKPASS_HANDLE;
if (!handle) process.exit(1);
const body = JSON.stringify({ prompt: process.argv.slice(2).join(' ') });

const request = http.request(
  {
    socketPath: handle,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Lanefold-Token': process.env.LANEFOLD_ASKPASS_TOKEN || '',
    },
  },
  (response) => {
    let data = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => (data += chunk));
    response.on('end', () => {
      if (response.statusCode !== 200) process.exit(1);
      try {
        const { answer } = JSON.parse(data);
        if (typeof answer === 'string') {
          process.stdout.write(`${answer}\n`);
          process.exit(0);
        }
      } catch {
        // fall through
      }
      process.exit(1);
    });
  },
);
request.on('error', () => process.exit(1));
request.end(body);
