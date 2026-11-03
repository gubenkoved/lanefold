import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import type { CodeHost } from '../../../shared/codeHosts';
import { Icon } from '../../components/Icon';
import { useHost } from '../../hostContext';
import { openLink } from '../../state/codeHosts';
import { hostIcon, linkOn, remotesAmong } from './codeLinks';
import type { Containment } from './ContainedIn';
import { copyWithToast, ShaChip } from './parts';
import styles from './HashCard.module.css';

/** How long the pointer rests on the hash before the card opens, and may stray before it closes. */
const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 250;

/**
 * A commit's hash (a click copies it) that, pointed at or reached with the keyboard, offers the
 * commit on its code host: open it there or copy its link, once a remote is known to have it.
 */
export function HashCard({
  sha,
  hosts,
  containment,
}: {
  sha: string;
  /** The repository's code hosts (not empty), in the order links prefer them. */
  hosts: readonly CodeHost[];
  containment: Containment;
}) {
  const { rpc } = useHost();
  // Open for this commit: another one selected, its card waits to be asked for.
  const [openFor, setOpenFor] = useState<string>();
  const open = openFor === sha;
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const rootRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Focus coming back to the hash as the card closes: it does not open the card again. */
  const returning = useRef(false);
  const id = useId();

  const later = (next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpenFor(next ? sha : undefined), delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    const reference = rootRef.current;
    const card = cardRef.current;
    if (!open || !reference || !card) return;
    // Kept beside the hash while the pane scrolls or resizes.
    const stop = autoUpdate(reference, card, () => {
      void computePosition(reference, card, {
        strategy: 'fixed',
        placement: 'bottom-start',
        middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
      }).then(({ x, y }) => setPosition({ x, y }));
    });
    return () => {
      stop();
      setPosition(undefined);
    };
  }, [open]);

  const close = (refocus: boolean) => {
    clearTimeout(timer.current);
    setOpenFor(undefined);
    if (!refocus) return;
    returning.current = true;
    rootRef.current?.querySelector('button')?.focus();
    returning.current = false;
  };
  const onFocus = (event: FocusEvent) => {
    // Reached with the keyboard: what pointing at it offers.
    if (
      !returning.current &&
      event.target === event.currentTarget.firstElementChild &&
      event.target.matches(':focus-visible')
    )
      later(true, 0);
  };
  const onBlur = (event: FocusEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) later(false, 0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      close(true);
    }
  };

  const link = containment.containing
    ? linkOn(hosts, remotesAmong(containment.containing), { kind: 'commit', sha })
    : undefined;
  const preferred = link && 'host' in link ? link.host : hosts[0]!;
  return (
    <span
      ref={rootRef}
      className={styles.root}
      onPointerEnter={() => later(true, open ? 0 : OPEN_DELAY_MS)}
      onPointerLeave={() => {
        // Not while the keyboard is in the card: its focus would be lost.
        if (!cardRef.current?.contains(document.activeElement)) later(false, CLOSE_DELAY_MS);
      }}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <ShaChip sha={sha} />
      {open ? (
        <div
          ref={cardRef}
          className={styles.card}
          role="group"
          aria-labelledby={`${id}-hash`}
          style={{
            left: position?.x ?? -9999,
            top: position?.y ?? -9999,
            visibility: position ? 'visible' : 'hidden',
          }}
        >
          <div id={`${id}-hash`} className={styles.hash}>
            <span className={styles.visuallyHidden}>Commit </span>
            {sha}
          </div>
          {link && 'url' in link ? (
            <>
              <button
                type="button"
                className={styles.action}
                title={link.url}
                onClick={() => {
                  openLink(rpc, link.url);
                  close(false);
                }}
              >
                <Icon name={hostIcon(link.host)} />
                <span>Open on {link.host.name}</span>
                <span className={styles.aside}>{link.host.repository}</span>
              </button>
              <button
                type="button"
                className={styles.action}
                onClick={() => {
                  void copyWithToast(link.url, 'link');
                  close(true);
                }}
              >
                <Icon name="link" />
                <span>Copy link</span>
              </button>
            </>
          ) : (
            <p className={styles.note}>
              {link ? (
                <>
                  <Icon name="cloud-upload" /> {link.reason}
                </>
              ) : containment.error ? (
                <>
                  <Icon name="info" /> Where it is pushed is not known: {containment.error}
                </>
              ) : (
                <>
                  <Icon name="loading" spin /> Looking for it on {preferred.name}…
                </>
              )}
            </p>
          )}
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              void copyWithToast(sha, 'hash');
              close(true);
            }}
          >
            <Icon name="copy" />
            <span>Copy hash</span>
          </button>
        </div>
      ) : null}
    </span>
  );
}
