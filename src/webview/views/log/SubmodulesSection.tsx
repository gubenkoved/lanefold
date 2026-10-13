import { useId, useState, type KeyboardEvent } from 'react';
import type { SubmoduleInfo } from '../../../shared/models';
import { Icon } from '../../components/Icon';
import type { MenuAnchor } from '../../components/Menu';
import { useHost } from '../../hostContext';
import { useQuery, useRepoVersion } from '../../state/queries';
import {
  addSubmodule,
  describeSubmodule,
  openLinkedRepository,
  showSubmoduleMenu,
  showSubmodulesMenu,
  SUBMODULE_BADGES,
  updateSubmodules,
} from './submodules';
import paneStyles from './BranchesPane.module.css';
import styles from './SubmodulesSection.module.css';

/** A row's main action (double click, Enter): show it in Lanefold, or check it out first. */
function openOrInitialize(repoId: string, submodule: SubmoduleInfo): void {
  if (submodule.state === 'uninitialized') updateSubmodules([submodule.path], true);
  else if (submodule.state === 'missing') updateSubmodules([submodule.path]);
  else void openLinkedRepository(repoId, submodule.path);
}

export interface SubmodulesSectionProps {
  readonly repoId: string;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

/** The repository's submodules under its branches: where each stands, actions in its menu. */
export function SubmodulesSection({ repoId, collapsed, onToggle }: SubmodulesSectionProps) {
  const host = useHost();
  // Submodules follow commits, the index and their own folders (working tree changes here).
  const version = useRepoVersion(host.rpc, repoId, ['refs', 'head', 'index', 'worktree']);
  const list = useQuery(`${repoId}:submodules:${version}`, () =>
    host.rpc.call('submodule.list', { repoId }),
  ).data;
  /** 0 is the section's header, 1… its rows; undefined until the list is used. */
  const [focus, setFocus] = useState<number>();
  const prefix = useId();
  if (!list || list.length === 0) return null;

  const count = collapsed ? 1 : list.length + 1;
  const focused = focus === undefined ? undefined : Math.min(focus, count - 1);
  const idOf = (index: number) => `${prefix}-submodule-${index}`;
  const anchorOf = (index: number): MenuAnchor => document.getElementById(idOf(index)) ?? { x: 0, y: 0 };
  const menu = (index: number, anchor: MenuAnchor) => {
    setFocus(index);
    if (index === 0) showSubmodulesMenu(list, anchor);
    else showSubmoduleMenu(repoId, list[index - 1]!, anchor);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = focused ?? 0;
    const move = (to: number) => {
      const next = Math.max(0, Math.min(count - 1, to));
      setFocus(next);
      document.getElementById(idOf(next))?.scrollIntoView({ block: 'nearest' });
    };
    if (event.key === 'ArrowDown') move(focused === undefined ? 0 : index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(count - 1);
    else if (event.key === 'ArrowRight' && index === 0) {
      if (collapsed) onToggle();
      else move(1);
    } else if (event.key === 'ArrowLeft') {
      if (index === 0 && !collapsed) onToggle();
      else move(0);
    } else if ((event.key === 'Enter' || event.key === ' ') && index === 0) onToggle();
    else if (event.key === 'Enter') openOrInitialize(repoId, list[index - 1]!);
    else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))
      menu(index, anchorOf(index));
    else return;
    event.preventDefault();
  };

  return (
    <div
      className={styles.submodules}
      role="tree"
      aria-label="Submodules"
      tabIndex={0}
      aria-activedescendant={focused === undefined ? undefined : idOf(focused)}
      onKeyDown={onKeyDown}
    >
      <div
        id={idOf(0)}
        role="treeitem"
        aria-level={1}
        aria-expanded={!collapsed}
        className={paneStyles.section}
        data-focused={focused === 0}
        onClick={() => {
          setFocus(0);
          onToggle();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          menu(0, { x: event.clientX, y: event.clientY });
        }}
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} className={paneStyles.chevron} />
        <span className={paneStyles.name}>Submodules</span>
        <span className={paneStyles.count}>{list.length}</span>
        <button
          type="button"
          className={paneStyles.sectionAction}
          tabIndex={-1}
          title="Add a submodule…"
          aria-label="Add a submodule"
          onClick={(event) => {
            event.stopPropagation();
            addSubmodule();
          }}
        >
          <Icon name="add" />
        </button>
      </div>
      {collapsed
        ? null
        : list.map((submodule, index) => (
            <div
              key={submodule.path}
              id={idOf(index + 1)}
              role="treeitem"
              aria-level={2}
              aria-label={`${submodule.path}: ${SUBMODULE_BADGES[submodule.state]}${submodule.settingsUrl ? ', URL changed' : ''}`}
              className={paneStyles.row}
              data-focused={focused === index + 1}
              style={{ paddingLeft: 18 }}
              title={[submodule.path, describeSubmodule(submodule), submodule.url]
                .filter(Boolean)
                .join(' · ')}
              onClick={() => setFocus(index + 1)}
              onDoubleClick={() => openOrInitialize(repoId, submodule)}
              onContextMenu={(event) => {
                event.preventDefault();
                menu(index + 1, { x: event.clientX, y: event.clientY });
              }}
            >
              <Icon name="file-submodule" className={paneStyles.refIcon} />
              <span className={paneStyles.name}>{submodule.path}</span>
              {submodule.settingsUrl ? (
                <Icon
                  name="link"
                  className={styles.urlChanged}
                  title={`Its URL changed in .gitmodules: fetches still use ${submodule.settingsUrl} until it is synced`}
                />
              ) : null}
              <span className={styles.badge} data-state={submodule.state}>
                {SUBMODULE_BADGES[submodule.state]}
              </span>
            </div>
          ))}
    </div>
  );
}
