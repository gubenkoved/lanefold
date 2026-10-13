import { describe, expect, it } from 'vitest';
import { OidTable } from '../../src/core/log/oidTable';

describe('OidTable', () => {
  it('interns hex object IDs to stable dense IDs', () => {
    const table = new OidTable(20, 4);
    const a = new TextEncoder().encode('a'.repeat(40));
    const b = new TextEncoder().encode('B'.repeat(40)); // uppercase hex is accepted too
    expect(table.internHex(a, 0)).toBe(0);
    expect(table.internHex(b, 0)).toBe(1);
    expect(table.internHex(a, 0)).toBe(0);
    expect(table.count).toBe(2);
    expect(Array.from(table.slice(1, 2))).toEqual(new Array(20).fill(0xbb));
  });

  it('stays linear when many object IDs share a long prefix (no quadratic probing)', () => {
    const table = new OidTable(20);
    const count = 100_000;
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      // Identical first 8 bytes — an adversarial (or synthetic) worst case for prefix hashing.
      const hex = 'deadbeefcafebabe' + i.toString(16).padStart(24, '0');
      table.internHex(new TextEncoder().encode(hex), 0);
    }
    expect(table.count).toBe(count);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
