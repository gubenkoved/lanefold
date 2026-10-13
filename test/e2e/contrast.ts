import type { Locator } from '@playwright/test';

/**
 * The texts in an element whose colour contrast against what is behind them is under `minimum`
 * (WCAG AA: 4.5:1 for body text). Backgrounds are composed up the tree, translucent colours and
 * opacity included; texts hidden from assistive technology or part of a disabled control are
 * exempt, as WCAG exempts them.
 */
export async function lowContrast(target: Locator, minimum = 4.5): Promise<string[]> {
  return target.evaluate((root, min) => {
    type Rgba = [number, number, number, number];
    const parse = (value: string): Rgba => {
      const numbers = (text: string) =>
        text
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number);
      let match = /^rgba?\((.*)\)$/.exec(value);
      if (match) {
        const [r, g, b, a] = numbers(match[1]!);
        return [r! / 255, g! / 255, b! / 255, a ?? 1];
      }
      match = /^color\(srgb (.*)\)$/.exec(value);
      if (match) {
        const [r, g, b, a] = numbers(match[1]!);
        return [r!, g!, b!, a ?? 1];
      }
      throw new Error(`Unexpected colour ${value}`);
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => [
      top[0] * top[3] + bottom[0] * (1 - top[3]),
      top[1] * top[3] + bottom[1] * (1 - top[3]),
      top[2] * top[3] + bottom[2] * (1 - top[3]),
      1,
    ];
    const luminance = ([r, g, b]: Rgba) => {
      const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    };
    // The test project has no DOM types: elements and styles, typed as far as needed.
    interface Box {
      readonly parentElement: Box | null;
      readonly childNodes: ArrayLike<{ readonly nodeType: number; readonly textContent: string | null }>;
      readonly textContent: string | null;
      closest(selector: string): unknown;
      getClientRects(): ArrayLike<unknown>;
    }
    const { getComputedStyle } = globalThis as unknown as {
      getComputedStyle(element: Box): { backgroundColor: string; color: string; opacity: string };
    };
    const TEXT_NODE = 3;
    const failures: string[] = [];
    const leaves = (Array.from(root.querySelectorAll('*')) as Box[]).filter(
      (element) =>
        Array.from(element.childNodes).some(
          (node) => node.nodeType === TEXT_NODE && node.textContent!.trim(),
        ) &&
        // Hidden from assistive technology, or part of a control that is off (WCAG exempts both).
        !element.closest('[aria-hidden="true"], :disabled, [aria-disabled="true"]') &&
        element.getClientRects().length > 0,
    );
    for (const element of leaves) {
      const chain: Box[] = [];
      for (let node: Box | null = element; node; node = node.parentElement) chain.unshift(node);
      let background: Rgba = [1, 1, 1, 1];
      let opacity = 1;
      for (const node of chain) {
        const style = getComputedStyle(node);
        background = over(parse(style.backgroundColor), background);
        opacity *= Number(style.opacity);
      }
      const color = parse(getComputedStyle(element).color);
      const text = over([color[0], color[1], color[2], color[3] * opacity], background);
      const [light, dark] = [luminance(text), luminance(background)].sort((a, b) => b - a);
      const ratio = (light! + 0.05) / (dark! + 0.05);
      if (ratio < min)
        failures.push(
          `“${element.textContent!.trim()}” ${ratio.toFixed(2)}:1 (${getComputedStyle(element).color})`,
        );
    }
    return failures;
  }, minimum);
}
