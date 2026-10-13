import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Icon } from './Icon';
import { closeMenu, type MenuAnchor } from './Menu';
import styles from './Picker.module.css';

export interface PickerItem {
  /** The value handed to `onPick` (a ref name, a commit hash…). */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly group?: string;
}

export interface PickerOptions {
  readonly title?: string;
  readonly placeholder?: string;
  readonly items: readonly PickerItem[];
  /** Several items can be checked and applied at once. */
  readonly multi?: boolean;
  readonly selected?: readonly string[];
  /** Offers the typed text itself as a choice (e.g. a commit hash or a glob). */
  readonly custom?: (text: string) => PickerItem | undefined;
  readonly applyLabel?: string;
  readonly onPick: (values: readonly string[]) => void;
}

interface PickerState {
  readonly open: boolean;
  readonly anchor?: MenuAnchor;
  readonly options?: PickerOptions;
  /** Where focus goes back to when the picker closes. */
  readonly returnFocus?: HTMLElement;
  /** Increments per opened picker (a fresh panel each time). */
  readonly version: number;
}

const usePickerStore = create<PickerState>(() => ({ open: false, version: 0 }));

/** Opens a searchable list anchored at an element or a point. */
export function openPicker(anchor: MenuAnchor, options: PickerOptions): void {
  // A picker opened from a menu item returns focus where the menu would have.
  const active = document.activeElement;
  closeMenu();
  const after = document.activeElement;
  const previous = usePickerStore.getState();
  const returnFocus = previous.open
    ? previous.returnFocus
    : after instanceof HTMLElement && after !== document.body && !after.closest('[data-lf-picker]')
      ? after
      : active instanceof HTMLElement && active !== document.body
        ? active
        : undefined;
  usePickerStore.setState((state) => ({
    open: true,
    anchor,
    options,
    returnFocus,
    version: state.version + 1,
  }));
}

export function closePicker(): void {
  const { open, returnFocus } = usePickerStore.getState();
  if (!open) return;
  usePickerStore.setState({ open: false, anchor: undefined, options: undefined, returnFocus: undefined });
  // Focus goes back to what opened the picker (unless it already moved on); whatever a choice
  // opens next can still take it.
  const active = document.activeElement;
  if (returnFocus?.isConnected && (!active || active === document.body || active.closest('[data-lf-picker]')))
    returnFocus.focus({ preventScroll: true });
}

/** Case-insensitive match of all space-separated words, scored so prefix matches come first. */
function score(item: PickerItem, words: readonly string[]): number {
  if (words.length === 0) return 1;
  const label = item.label.toLowerCase();
  const haystack = `${label} ${item.description?.toLowerCase() ?? ''}`;
  let total = 0;
  for (const word of words) {
    const index = haystack.indexOf(word);
    if (index < 0) return 0;
    total += index === 0 ? 4 : label.includes(`/${word}`) ? 3 : index < label.length ? 2 : 1;
  }
  return total;
}

/** Items a Page Up or Page Down moves by. */
const PAGE = 10;

function PickerPanel({ anchor, options }: { anchor: MenuAnchor; options: PickerOptions }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(options.selected ?? []));
  const [position, setPosition] = useState<{ x: number; y: number } | undefined>();

  const visible = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = options.items
      .map((item, index) => ({ item, index, score: score(item, words) }))
      .filter((entry) => entry.score > 0);
    // Keep the given order (groups) unless searching; then best matches first.
    if (words.length > 0) matches.sort((a, b) => b.score - a.score || a.index - b.index);
    const custom = query.trim() ? options.custom?.(query.trim()) : undefined;
    const items = matches.map((entry) => entry.item);
    if (custom && !items.some((item) => item.value === custom.value)) items.push(custom);
    return items;
  }, [options, query]);

  useLayoutEffect(() => {
    if (!panelRef.current) return;
    const reference =
      anchor instanceof Element
        ? anchor
        : {
            getBoundingClientRect: () => ({
              x: anchor.x,
              y: anchor.y,
              left: anchor.x,
              top: anchor.y,
              right: anchor.x,
              bottom: anchor.y,
              width: 0,
              height: 0,
            }),
          };
    void computePosition(reference, panelRef.current, {
      strategy: 'fixed',
      placement: 'bottom-start',
      middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    }).then(({ x, y }) => setPosition({ x, y }));
  }, [anchor]);

  // Take focus once the panel is visible (a hidden element cannot have it), so typing filters.
  const placed = position !== undefined;
  useLayoutEffect(() => {
    if (placed) inputRef.current?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) closePicker();
    };
    // Escape closes the picker wherever focus is, before the focused view sees the key (the
    // graph would clear its selection).
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      closePicker();
    };
    const onBlur = () => closePicker();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (item: PickerItem) => {
    if (options.multi) {
      setChecked((current) => {
        const next = new Set(current);
        if (next.has(item.value)) next.delete(item.value);
        else next.add(item.value);
        return next;
      });
      return;
    }
    closePicker();
    options.onPick([item.value]);
  };
  const apply = () => {
    closePicker();
    options.onPick([...checked]);
  };

  // A group header above the first item of each group (not while searching: results mix).
  const headers = visible.map((item, index) =>
    !query && (index === 0 || visible[index - 1]!.group !== item.group) ? item.group : undefined,
  );
  return (
    <div
      ref={panelRef}
      className={styles.panel}
      role="dialog"
      aria-label={options.title ?? 'Choose'}
      data-lf-picker=""
      style={{ left: position?.x ?? 0, top: position?.y ?? 0, visibility: position ? 'visible' : 'hidden' }}
      onKeyDown={(event) => {
        // Tab moves between the search box and the panel's buttons; focus stays in the picker.
        if (event.key !== 'Tab' || !panelRef.current) return;
        const stops = [
          ...panelRef.current.querySelectorAll<HTMLElement>(
            'input, button:not([tabindex="-1"]):not(:disabled)',
          ),
        ];
        const index = stops.indexOf(document.activeElement as HTMLElement);
        const next = stops[(index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length];
        event.preventDefault();
        next?.focus();
      }}
    >
      {options.title ? <div className={styles.title}>{options.title}</div> : null}
      <label className={styles.search}>
        <Icon name="search" />
        <input
          ref={inputRef}
          value={query}
          placeholder={options.placeholder ?? 'Type to filter'}
          spellCheck={false}
          role="combobox"
          aria-label={options.title ?? options.placeholder ?? 'Filter'}
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls="lf-picker-list"
          aria-activedescendant={visible[active] ? `lf-picker-option-${active}` : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            // Enter that confirms an input method's word is not a choice.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            const last = visible.length - 1;
            if (event.key === 'ArrowDown') setActive((i) => Math.min(last, i + 1));
            else if (event.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
            else if (event.key === 'PageDown') setActive((i) => Math.max(0, Math.min(last, i + PAGE)));
            else if (event.key === 'PageUp') setActive((i) => Math.max(0, i - PAGE));
            else if (event.key === 'Enter') {
              if (options.multi && (event.ctrlKey || event.metaKey)) apply();
              else if (visible[active]) choose(visible[active]);
            } else return;
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      </label>
      <div
        ref={listRef}
        id="lf-picker-list"
        className={styles.list}
        role="listbox"
        aria-label={options.title ?? 'Choices'}
        aria-multiselectable={options.multi}
      >
        {visible.length === 0 ? <div className={styles.empty}>No matches</div> : null}
        {visible.map((item, index) => {
          const header = headers[index];
          return (
            <div key={`${item.group ?? ''}:${item.value}`} role="presentation">
              {header ? <div className={styles.group}>{header}</div> : null}
              <button
                type="button"
                role="option"
                id={`lf-picker-option-${index}`}
                // The list is driven from the search box: its items are not Tab stops.
                tabIndex={-1}
                data-index={index}
                aria-selected={options.multi ? checked.has(item.value) : index === active}
                className={styles.item}
                data-active={index === active}
                onPointerMove={() => setActive(index)}
                // Keep focus in the search box: typing goes on filtering after a click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
              >
                {options.multi ? (
                  <Icon
                    name={checked.has(item.value) ? 'pass-filled' : 'circle-large-outline'}
                    className={styles.check}
                  />
                ) : null}
                {item.icon ? <Icon name={item.icon} className={styles.icon} /> : null}
                <span className={styles.label}>{item.label}</span>
                {item.description ? <span className={styles.description}>{item.description}</span> : null}
              </button>
            </div>
          );
        })}
      </div>
      {options.multi ? (
        <div className={styles.footer}>
          <span className={styles.selectedCount}>{checked.size} selected</span>
          <button
            type="button"
            className={styles.apply}
            disabled={checked.size === 0}
            title={`${options.applyLabel ?? 'Apply'} (Ctrl+Enter)`}
            onClick={apply}
          >
            {options.applyLabel ?? 'Apply'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Renders the open picker. Mount once at the app root. */
export function PickerHost() {
  const { open, anchor, options, version } = usePickerStore();
  if (!open || !anchor || !options) return null;
  return <PickerPanel key={version} anchor={anchor} options={options} />;
}
