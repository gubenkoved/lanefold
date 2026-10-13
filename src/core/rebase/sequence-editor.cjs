#!/usr/bin/env node
/*
 * Lanefold's GIT_SEQUENCE_EDITOR for visual history editing.
 *
 * git calls it with the path of the todo it generated. It replaces that todo with the one
 * Lanefold planned — but only if git is about to rebase exactly the commits that were planned
 * (same commits, same order). Anything else (HEAD moved, another tool changed the branch)
 * exits with an error, which makes git abort the rebase before touching anything.
 *
 * Branches git chose to move along (`--update-refs`) keep their `update-ref` lines, placed
 * after the commit each branch pointed at, wherever that commit went.
 *
 * It also leaves a copy of the plan next to the todo (rebase-merge/lanefold-plan.json), which
 * lives exactly as long as the rebase and tells Lanefold the rebase is one of its history edits
 * (and which of its `edit` stops split a commit).
 *
 * Plain CommonJS on purpose: it runs under `node` (or VS Code's Electron in node mode) as is.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const COMMAND = /^(pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d)\s+(?:-[cC]\s+)?([0-9a-f]{4,64})\b/i;
const UPDATE_REF = /^(?:update-ref|u)\s+(\S+)/i;

function fail(message) {
  process.stderr.write(`lanefold: ${message}\n`);
  process.exit(1);
}

// Leaving out a step that failed (`git rebase --edit-todo`): git put it back at the top of the
// todo. Exactly that line goes, or nothing does.
const dropping = process.env.LANEFOLD_TODO_DROP;
if (dropping) {
  const todo = process.argv[2];
  if (!todo) fail('missing todo path');
  const lines = fs.readFileSync(todo, 'utf8').split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  const command = first >= 0 ? COMMAND.exec(lines[first].trim()) : null;
  const id = command ? command[2].toLowerCase() : '';
  if (!command || id.length < 4 || !dropping.toLowerCase().startsWith(id)) {
    fail('the step to leave out is no longer the next one; nothing was changed');
  }
  lines.splice(first, 1);
  fs.writeFileSync(todo, lines.join('\n'));
  process.exit(0);
}

const todoPath = process.argv[2];
const planPath = process.env.LANEFOLD_REBASE_PLAN;
if (!todoPath || !planPath) fail('missing todo or plan path');

let plan;
try {
  plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
} catch (error) {
  fail(`cannot read the plan: ${error.message}`);
}
const expected = plan.expected;
if (!Array.isArray(expected) || !Array.isArray(plan.lines) || typeof plan.anchors !== 'object') {
  fail('the plan is malformed');
}

// The commits git listed, and which commit each of git's update-ref lines follows.
const generated = [];
const updates = [];
for (const raw of fs.readFileSync(todoPath, 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  const command = COMMAND.exec(line);
  if (command) {
    generated.push(command[2].toLowerCase());
    continue;
  }
  const update = UPDATE_REF.exec(line);
  if (update) updates.push({ ref: update[1], after: generated.length - 1 });
}

const matches =
  generated.length === expected.length &&
  generated.every((abbreviated, index) => String(expected[index]).startsWith(abbreviated));
if (!matches) {
  fail(
    `the branch changed since the history edit was planned (expected ${expected.length} commits, git listed ${generated.length}); nothing was changed`,
  );
}

const after = new Map();
for (const { ref, after: index } of updates) {
  const anchor = index < 0 ? -1 : plan.anchors[expected[index]];
  const at = typeof anchor === 'number' ? anchor : plan.lines.length - 1;
  if (!after.has(at)) after.set(at, []);
  after.get(at).push(`update-ref ${ref}`);
}
const lines = [...(after.get(-1) || [])];
plan.lines.forEach((line, index) => lines.push(line, ...(after.get(index) || [])));

fs.writeFileSync(todoPath, `${lines.join('\n')}\n`);
try {
  fs.writeFileSync(path.join(path.dirname(todoPath), 'lanefold-plan.json'), JSON.stringify(plan));
} catch {
  // Only a hint for the banner; the rebase itself does not need it.
}
