import { describe, expect, it } from 'vitest';
import { initials } from '../../src/webview/graph/format';

describe('initials', () => {
  it('takes the first and last word', () => {
    expect(initials('Carol Chen')).toBe('CC');
    expect(initials('Alice B. Archer')).toBe('AA');
    expect(initials('madonna')).toBe('M');
  });

  it('takes whole characters, from words that start with a letter or digit', () => {
    expect(initials('Zoë Ångström 🚀')).toBe('ZÅ');
    expect(initials('山田 太郎')).toBe('山太');
    expect(initials('🚀 rocket')).toBe('R');
    expect(initials('🚀')).toBe('?');
    expect(initials('   ')).toBe('?');
  });
});
