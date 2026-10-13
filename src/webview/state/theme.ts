import { useEffect, useMemo, useState } from 'react';
import type { AnimationLevel } from '../../shared/models';
import { PALETTE_SIZE } from '../graph/logModel';
import { buildPalette, detectThemeKind, type Palette, type ThemeKind } from '../graph/palette';
import { useApp } from './store';

/** The current VS Code theme kind; follows theme switches (VS Code updates the body class). */
export function useThemeKind(): ThemeKind {
  const [kind, setKind] = useState<ThemeKind>(() => detectThemeKind());
  useEffect(() => {
    const observer = new MutationObserver(() => setKind(detectThemeKind()));
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return kind;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The animation level in effect: the setting, lowered to 'reduced' by the OS preference. */
export function useAnimationLevel(): AnimationLevel {
  const setting = useApp((state) => state.settings.animations);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return setting === 'full' && reduced ? 'reduced' : setting;
}

/** The lane palette for the current theme and color settings. */
export function usePalette(): Palette {
  const kind = useThemeKind();
  const colors = useApp((state) => state.settings.colors);
  return useMemo(() => buildPalette(kind, PALETTE_SIZE, colors), [kind, colors]);
}
