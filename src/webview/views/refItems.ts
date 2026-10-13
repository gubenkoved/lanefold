import type { RefsSnapshot } from '../../shared/models';
import type { PickerItem } from '../components/Picker';
import { shortSha } from '../graph/format';

/** Branches, remotes and tags as picker items (current branch first). */
export function refPickerItems(
  snapshot: RefsSnapshot,
  options: { includeHead?: boolean } = {},
): PickerItem[] {
  const items: PickerItem[] = [];
  const head = snapshot.head;
  if (options.includeHead && !head.unborn) {
    items.push({
      value: 'HEAD',
      label: 'HEAD',
      description: head.detached ? `detached at ${shortSha(head.sha ?? '')}` : head.branch,
      icon: 'target',
      group: 'Current',
    });
  }
  const byKind = (kind: 'branch' | 'remote' | 'tag') =>
    snapshot.refs
      .filter((ref) => ref.kind === kind && !ref.name.endsWith('/HEAD'))
      .sort((a, b) => Number(!!b.isHead) - Number(!!a.isHead) || a.short.localeCompare(b.short));
  for (const ref of byKind('branch')) {
    items.push({
      value: ref.short,
      label: ref.short,
      description: ref.isHead ? 'current branch' : ref.upstream,
      icon: ref.isHead ? 'check' : 'git-branch',
      group: 'Branches',
    });
  }
  for (const ref of byKind('remote')) {
    items.push({ value: ref.short, label: ref.short, icon: 'cloud', group: 'Remote branches' });
  }
  for (const ref of byKind('tag')) {
    items.push({ value: ref.short, label: ref.short, icon: 'tag', group: 'Tags' });
  }
  return items;
}

/** Lets the picker accept a typed commit hash or other revision ("HEAD~3", "v1.0^{}"). */
export function customRevision(text: string): PickerItem | undefined {
  if (text.startsWith('-') || /\s/.test(text)) return undefined;
  if (/^[0-9a-f]{4,64}$/i.test(text)) {
    return {
      value: text.toLowerCase(),
      label: text.toLowerCase(),
      description: 'commit',
      icon: 'git-commit',
    };
  }
  return { value: text, label: text, description: 'revision', icon: 'symbol-key' };
}
