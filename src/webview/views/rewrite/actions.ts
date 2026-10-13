/*
 * The editor's actions (pick, reword, edit, split, squash, fixup, drop): names, keys, icons and
 * what they do, and the menu that sets them.
 */

import type { RewriteAction } from '../../../shared/rewrite';
import { openMenu, type MenuAnchor } from '../../components/Menu';
import { select, setAction, useRewrite } from '../../state/rewrite';

export const ACTIONS: Record<
  RewriteAction,
  { readonly label: string; readonly key: string; readonly icon: string; readonly hint: string }
> = {
  pick: { label: 'Pick', key: 'p', icon: 'check', hint: 'Keep the commit as it is' },
  reword: { label: 'Reword', key: 'r', icon: 'edit', hint: 'Keep its changes, give it a new message' },
  edit: { label: 'Edit', key: 'e', icon: 'debug-pause', hint: 'Stop after this commit so you can change it' },
  squash: {
    label: 'Squash',
    key: 's',
    icon: 'fold-down',
    hint: 'Fold into the commit below it, combining the messages',
  },
  fixup: {
    label: 'Fixup',
    key: 'f',
    icon: 'combine',
    hint: 'Fold into the commit below it, keeping that commit’s message',
  },
  drop: { label: 'Drop', key: 'd', icon: 'trash', hint: 'Leave the commit out' },
  // "i": the letter of "split" that is free here and in git's todo (where s, p, l and t are taken).
  split: {
    label: 'Split',
    key: 'i',
    icon: 'split-vertical',
    hint: 'Stop with its changes uncommitted, to commit them in parts',
  },
};

export const ACTION_ORDER: readonly RewriteAction[] = [
  'pick',
  'reword',
  'edit',
  'split',
  'squash',
  'fixup',
  'drop',
];

/**
 * The menu of actions for a commit: for the whole selection when the commit is part of it,
 * otherwise for that commit alone (which becomes the selection).
 */
export function openActionMenu(anchor: MenuAnchor, sha: string): void {
  const session = useRewrite.getState().session;
  const entry = session?.entries.find((candidate) => candidate.sha === sha);
  if (!session || !entry) return;
  const targets = session.selection.includes(sha) ? session.selection : [sha];
  if (!session.selection.includes(sha)) select(sha);
  openMenu(
    anchor,
    ACTION_ORDER.map((action) => ({
      id: action,
      label: ACTIONS[action].label,
      icon: ACTIONS[action].icon,
      hint: ACTIONS[action].hint,
      shortcut: ACTIONS[action].key.toUpperCase(),
      checked: entry.action === action,
      danger: action === 'drop',
      onSelect: () => setAction(targets, action),
    })),
  );
}
