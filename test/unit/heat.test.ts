import { describe, expect, it } from 'vitest';
import { heatColors, heatScale } from '../../src/extension/blame/heat';

describe('blame heat', () => {
  it('spreads a file’s commits over the whole scale, newest hottest', () => {
    const day = 86_400;
    const heat = heatScale([0, 35 * day, 56 * day, 77 * day, 125 * day, 125 * day]);
    const values = [0, 35, 56, 77, 125].map((d) => heat(d * day));
    expect(values[0]).toBe(0);
    expect(values[4]).toBe(1);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    expect(heatScale([42])(42)).toBe(1);
  });

  it('makes recent changes warmer and more visible', () => {
    const hot = heatColors(1, 'dark');
    const cold = heatColors(0, 'dark');
    expect(hot.bar).toBe('rgba(255, 170, 80, 1.000)');
    expect(cold.bar).toBe('rgba(104, 130, 176, 0.700)');
    expect(heatColors(0.5, 'light').background).toMatch(/^rgba\(/);
  });
});
