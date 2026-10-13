import { describe, expect, it } from 'vitest';
import { GraphTopology } from '../../src/shared/graph/topology';

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0').repeat(5);

describe('GraphTopology object ID index', () => {
  it('finds rows by full object ID as IDs keep arriving, including colliding prefixes', () => {
    const topology = new GraphTopology(20, 4);
    // Nothing loaded yet.
    expect(topology.rowOfHex(hex(1))).toBe(-1);
    const ids: number[] = [];
    for (let n = 0; n < 5000; n++) {
      const id = topology.addOidHex(hex(Math.imul(n, 2654435761)));
      topology.appendRow(id, ids.length > 0 ? [ids.at(-1)!] : []);
      ids.push(id);
      // Lookups while the index grows.
      if (n % 997 === 0) expect(topology.rowOfHex(hex(Math.imul(n, 2654435761)))).toBe(n);
    }
    // Same first four bytes, different object.
    const twin = 'deadbeef' + '1'.repeat(32);
    const other = 'deadbeef' + '2'.repeat(32);
    topology.appendRow(topology.addOidHex(twin), []);
    topology.appendRow(topology.addOidHex(other), []);
    expect(topology.rowOfHex(twin)).toBe(5000);
    expect(topology.rowOfHex(other.toUpperCase())).toBe(5001);
    expect(topology.rowOfHex('deadbeef' + '3'.repeat(32))).toBe(-1);
    expect(topology.rowOfHex('deadbeef')).toBe(-1);
    for (let n = 0; n < 5000; n += 123) expect(topology.rowOfHex(hex(Math.imul(n, 2654435761)))).toBe(n);
  });
});
