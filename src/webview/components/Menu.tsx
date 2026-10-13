import { computePosition, flip, offset, shift, type Placement, type VirtualElement } from '@floating-ui/dom';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Icon } from './Icon';
import { hintKind } from './menuHint';
import styles from './Menu.module.css';

export type MenuEntry =
  | {
      readonly kind?: 'item';
      readonly id: string;
      readonly label: string;
      readonly icon?: string;
      /**
       * A secondary line, shown in the footer while the item is active: the git command the
       * action runs (after a `$` prompt when it starts with `git`), a value it uses, or a note.
       */
      readonly hint?: string;
      readonly shortcut?: string;
      readonly disabled?: boolean;
      /** Why the item is disabled: the footer says it when the item is pointed at. */
      readonly reason?: string;
      readonly danger?: boolean;
      readonly checked?: boolean;
      /** A color the label starts with (what the item stands for, e.g. a repository's). */
      readonly swatch?: string;
      readonly onSelect: () => void;
    }
  | {
      readonly kind: 'submenu';
      readonly id: string;
      readonly label: string;
      readonly icon?: string;
      readonly disabled?: boolean;
      /** Why the submenu is disabled (see an item's). */
      readonly reason?: string;
      readonly entries: readonly MenuEntry[];
    }
  | { readonly kind: 'separator' }
  /** A section label ("Order", "Bisect"). */
  | { readonly kind: 'header'; readonly label: string }
  /** What the menu acts on (a branch, a commit), named as written: case and all. */
  | { readonly kind: 'title'; readonly label: string };

export type MenuAnchor = Element | { readonly x: number; readonly y: number };

interface MenuState {
  readonly open: boolean;
  readonly anchor?: MenuAnchor;
  readonly entries: readonly MenuEntry[];
  readonly onClose?: () => void;
  /** Where focus goes back to when the menu closes (what had it before the menu opened). */
  readonly returnFocus?: HTMLElement;
  /** Increments per opened menu (a fresh panel each time). */
  readonly version: number;
}

const useMenuStore = create<MenuState>(() => ({ open: false, entries: [], version: 0 }));

/** Opens a menu at an element or a point (e.g. a context-menu click). */
export function openMenu(anchor: MenuAnchor, entries: readonly MenuEntry[], onClose?: () => void): void {
  const previous = useMenuStore.getState();
  previous.onClose?.();
  const active = document.activeElement;
  const returnFocus = previous.open
    ? previous.returnFocus
    : active instanceof HTMLElement && !active.closest('[role="menu"]')
      ? active
      : undefined;
  useMenuStore.setState((state) => ({
    open: true,
    anchor,
    entries,
    onClose,
    returnFocus,
    version: state.version + 1,
  }));
}

export function closeMenu(): void {
  const { onClose, returnFocus } = useMenuStore.getState();
  useMenuStore.setState({
    open: false,
    anchor: undefined,
    entries: [],
    onClose: undefined,
    returnFocus: undefined,
  });
  // Focus goes back where it was (the graph, the button that opened the menu), unless it already
  // moved on; whatever a chosen item opens next can still take it.
  const active = document.activeElement;
  if (returnFocus?.isConnected && (!active || active === document.body || active.closest('[role="menu"]')))
    returnFocus.focus({ preventScroll: true });
  onClose?.();
}

function toReference(anchor: MenuAnchor): Element | VirtualElement {
  if (anchor instanceof Element) return anchor;
  const { x, y } = anchor;
  return {
    getBoundingClientRect: () => ({ x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0 }),
  };
}

type ItemEntry = Extract<MenuEntry, { onSelect: () => void }>;
type SubmenuEntry = Extract<MenuEntry, { kind: 'submenu' }>;
type ActionEntry = ItemEntry | SubmenuEntry;
const isItem = (entry: MenuEntry): entry is ItemEntry => entry.kind === undefined || entry.kind === 'item';
const isSubmenu = (entry: MenuEntry): entry is SubmenuEntry => entry.kind === 'submenu';
/** Items and submenus can be active: disabled ones too, so they can say why they are. */
const focusable = (entry: MenuEntry): entry is ActionEntry => isItem(entry) || isSubmenu(entry);
const enabled = (entry: MenuEntry) => focusable(entry) && !entry.disabled;

const SUBMENU_DELAY_MS = 140;

/** The footer line for the active item: why it is disabled, or its hint. */
function FooterLine({ entry }: { entry: ActionEntry | undefined }) {
  if (!entry) return <span className={styles.footerIdle}>Point at an action for details</span>;
  const hint = isItem(entry) ? entry.hint : undefined;
  if (entry.disabled && (entry.reason || !hint)) {
    return (
      <span className={styles.reason}>
        <Icon name="circle-slash" className={styles.reasonIcon} />
        <span>{entry.reason ?? 'Not available here'}</span>
      </span>
    );
  }
  if (!hint) return null;
  const kind = hintKind(hint);
  if (kind === 'note') return <span className={styles.footerNote}>{hint}</span>;
  return (
    <span className={styles.footerHint} title={hint}>
      {kind === 'command' ? <span className={styles.prompt}>$ </span> : null}
      {hint}
    </span>
  );
}

interface PanelProps {
  readonly entries: readonly MenuEntry[];
  readonly reference: Element | VirtualElement;
  readonly placement: Placement;
  /** Start with the first item active (opened from the keyboard or a button). */
  readonly keyboard: boolean;
  /** Close this (sub)menu and return focus to the parent panel. */
  readonly onBack?: () => void;
}

function MenuPanel({ entries, reference, placement, keyboard, onBack }: PanelProps) {
  /** The panel (placed on screen) and, inside it, the menu itself (focused, scrolls). */
  const panelRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [active, setActive] = useState(() => {
    if (!keyboard) return -1;
    const first = entries.findIndex(enabled);
    return first >= 0 ? first : entries.findIndex(focusable);
  });
  const [child, setChild] = useState<
    { index: number; element: HTMLElement; keyboard: boolean } | undefined
  >();
  const [position, setPosition] = useState<{ x: number; y: number; origin: string } | undefined>();
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    if (!panelRef.current) return;
    void computePosition(reference, panelRef.current, {
      strategy: 'fixed',
      placement,
      middleware: [
        offset(placement.startsWith('right') ? -2 : reference instanceof Element ? 4 : 2),
        flip(),
        // Also slide along the other axis: in a short panel a long menu moves up rather than
        // running past the window (it never grows beyond it, see max-height).
        shift({ padding: 6, crossAxis: true }),
      ],
    }).then(({ x, y, placement: final }) => {
      const vertical = final.startsWith('top') ? 'bottom' : 'top';
      const horizontal = final.endsWith('end') || final.startsWith('left') ? 'right' : 'left';
      setPosition({ x, y, origin: `${vertical} ${horizontal}` });
    });
  }, [reference, placement]);

  // Take focus once the panel is visible (a hidden element cannot have it), so its keys work.
  const placed = position !== undefined;
  useLayoutEffect(() => {
    if (placed) ref.current?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const indices = entries.map((entry, index) => (focusable(entry) ? index : -1)).filter((i) => i >= 0);
  const activate = (index: number | undefined) => {
    if (index === undefined) return;
    setActive(index);
    ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  const move = (delta: number) => {
    if (indices.length === 0) return;
    const current = indices.indexOf(active);
    const next =
      current < 0
        ? delta > 0
          ? 0
          : indices.length - 1
        : (current + delta + indices.length) % indices.length;
    activate(indices[next]);
  };

  const openChild = (index: number, viaKeyboard: boolean) => {
    const element = ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (element) setChild({ index, element, keyboard: viaKeyboard });
  };

  const choose = (entry: ItemEntry) => {
    closeMenu();
    entry.onSelect();
  };

  const childEntry = child ? entries[child.index] : undefined;
  // What the active item runs (or why it cannot) shows in a footer line: compact menus that
  // still say exactly what happens. Menus with nothing to say there have none.
  const hasFooter = entries.some(
    (entry) => focusable(entry) && ((entry.disabled && entry.reason) || (isItem(entry) && entry.hint)),
  );
  const activeEntry = entries[active];
  const title = entries.find((entry) => entry.kind === 'title' || entry.kind === 'header');

  return (
    <>
      <div
        ref={panelRef}
        className={styles.menu}
        style={{
          left: position?.x ?? 0,
          top: position?.y ?? 0,
          visibility: position ? 'visible' : 'hidden',
          ['--lf-menu-origin' as string]: position?.origin,
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div
          ref={ref}
          role="menu"
          aria-label={title && 'label' in title ? title.label : undefined}
          // Focus stays on the menu (it scrolls; Tab closes it); screen readers follow the active item.
          tabIndex={0}
          aria-activedescendant={
            active >= 0 && activeEntry && focusable(activeEntry) ? `${id}-${active}` : undefined
          }
          className={styles.list}
          onKeyDown={(event) => {
            if (event.target !== ref.current) return; // a child panel handles its own keys
            const entry = entries[active];
            if (event.key === 'ArrowDown') move(1);
            else if (event.key === 'ArrowUp') move(-1);
            else if (event.key === 'Home') activate(indices[0]);
            else if (event.key === 'End') activate(indices[indices.length - 1]);
            else if (event.key === 'ArrowRight' && entry && isSubmenu(entry) && !entry.disabled)
              openChild(active, true);
            else if (event.key === 'ArrowLeft' && onBack) onBack();
            else if (event.key === 'Escape' || event.key === 'Tab') closeMenu();
            else if (event.key === 'Enter' || event.key === ' ') {
              // A disabled item stays put: the footer says why it is.
              if (entry && isItem(entry) && !entry.disabled) choose(entry);
              else if (entry && isSubmenu(entry) && !entry.disabled) openChild(active, true);
            } else return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {entries.map((entry, index) => {
            if (entry.kind === 'separator')
              return <div key={`sep-${index}`} className={styles.separator} role="separator" />;
            if (entry.kind === 'header')
              return (
                <div key={`hdr-${index}`} className={styles.header}>
                  {entry.label}
                </div>
              );
            if (entry.kind === 'title')
              return (
                <div key={`title-${index}`} className={styles.title} title={entry.label}>
                  {entry.label}
                </div>
              );
            const submenu = isSubmenu(entry);
            return (
              <button
                key={entry.id}
                id={`${id}-${index}`}
                type="button"
                tabIndex={-1}
                data-index={index}
                role={submenu ? 'menuitem' : entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={submenu ? undefined : entry.checked}
                aria-haspopup={submenu ? 'menu' : undefined}
                aria-expanded={submenu ? child?.index === index : undefined}
                // Disabled items can still be pointed at (and reached with the arrows) to say why.
                aria-disabled={entry.disabled || undefined}
                className={[styles.item, !submenu && entry.danger ? styles.danger : ''].join(' ')}
                data-active={index === active || child?.index === index}
                // Focus stays on the menu wherever it is clicked: its keys keep working.
                onMouseDown={(event) => event.preventDefault()}
                onPointerEnter={() => {
                  setActive(index);
                  clearTimeout(hoverTimer.current);
                  hoverTimer.current = setTimeout(() => {
                    if (submenu && !entry.disabled) openChild(index, false);
                    else if (child) {
                      // Closing the submenu the pointer left hands focus back to this panel.
                      setChild(undefined);
                      ref.current?.focus({ preventScroll: true });
                    }
                  }, SUBMENU_DELAY_MS);
                }}
                onPointerLeave={() => {
                  clearTimeout(hoverTimer.current);
                  if (!child) setActive(-1);
                }}
                onClick={() => {
                  if (entry.disabled) return;
                  if (submenu) openChild(index, false);
                  else choose(entry);
                }}
              >
                <span className={styles.icon}>
                  {!submenu && entry.checked ? (
                    <Icon name="check" />
                  ) : entry.icon ? (
                    <Icon name={entry.icon} />
                  ) : null}
                </span>
                <span className={styles.label}>
                  <span className={styles.labelText}>
                    {!submenu && entry.swatch ? (
                      <span
                        className={styles.swatch}
                        style={{ background: entry.swatch }}
                        aria-hidden="true"
                      />
                    ) : null}
                    {entry.label}
                  </span>
                </span>
                <span className={styles.shortcut}>
                  {submenu ? <Icon name="chevron-right" /> : entry.shortcut}
                </span>
              </button>
            );
          })}
        </div>
        {/* Beside the menu, not in it: a menu holds menu items only. */}
        {hasFooter ? (
          <div className={styles.footer} aria-live="polite">
            <FooterLine entry={activeEntry && focusable(activeEntry) ? activeEntry : undefined} />
          </div>
        ) : null}
      </div>
      {child && childEntry && isSubmenu(childEntry) ? (
        <MenuPanel
          key={child.index}
          entries={childEntry.entries}
          reference={child.element}
          placement="right-start"
          keyboard={child.keyboard}
          onBack={() => {
            setChild(undefined);
            ref.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </>
  );
}

/** Renders the single active menu (and its open submenus). Mount once at the app root. */
export function MenuHost() {
  const { open, anchor, entries, version } = useMenuStore();
  const rootRef = useRef<HTMLDivElement>(null);
  const reference = useMemo(() => (anchor ? toReference(anchor) : undefined), [anchor]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => !rootRef.current?.contains(event.target as Node);
    const onPointerDown = (event: PointerEvent) => {
      if (outside(event)) closeMenu();
    };
    // Escape closes the menu even while focus is elsewhere, before the focused view sees the key
    // (the graph would clear its selection).
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !outside(event)) return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    };
    const onBlur = () => closeMenu();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [open]);

  if (!open || !anchor || !reference) return null;
  // Menus opened from a button (keyboard-friendly) start with the first item active.
  return (
    <div ref={rootRef} className={styles.root}>
      <MenuPanel
        key={version}
        entries={entries}
        reference={reference}
        placement={anchor instanceof Element ? 'bottom-start' : 'right-start'}
        keyboard={anchor instanceof Element}
      />
    </div>
  );
}
