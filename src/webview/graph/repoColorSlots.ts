import { stringHash } from './format';

/** Hues around the wheel, 30° apart; repositories beyond them reuse the hues, lighter or darker. */
export const REPO_HUES = 12;

const FIRST_HUE = 15;

/** The hue of a repository color slot (its color in each theme is made of it, see repoColors.ts). */
export function repoHue(slot: number): number {
  return (FIRST_HUE + (slot % REPO_HUES) * 30) % 360;
}

/** The slot a key's hash picks. */
export function preferredSlot(key: string): number {
  return stringHash(key) % REPO_HUES;
}

/** The free slot nearest to `preferred`, if possible not next to a taken one (a similar hue). */
function freeSlot(preferred: number, taken: ReadonlySet<number>): number {
  const near = (slot: number) =>
    taken.has((slot + 1) % REPO_HUES) || taken.has((slot + REPO_HUES - 1) % REPO_HUES);
  for (const spaced of [true, false]) {
    for (let distance = 0; distance <= REPO_HUES / 2; distance++) {
      for (const slot of [
        (preferred + distance) % REPO_HUES,
        (preferred + REPO_HUES - distance) % REPO_HUES,
      ]) {
        if (!taken.has(slot) && !(spaced && near(slot))) return slot;
      }
    }
  }
  // Every hue is taken: the same hue in another lightness.
  return preferred + REPO_HUES;
}

/**
 * Color slots for repositories, keyed by what names them for good (their git directories).
 * `given` remembers the slots handed out: a repository keeps its color while others come and go
 * (and gives it back when it closes). A new one takes the slot its key's hash picks, or the free
 * slot nearest to it that is not next to another repository's (new ones in hash order, so the
 * order of `keys` does not matter): the same workspace gets the same colors every time.
 */
export function assignColorSlots(keys: readonly string[], given: Map<string, number>): number[] {
  for (const key of [...given.keys()]) if (!keys.includes(key)) given.delete(key);
  const taken = new Set<number>();
  const slots = keys.map((key) => {
    const slot = given.get(key);
    if (slot !== undefined) taken.add(slot);
    return slot ?? -1;
  });
  const fresh = keys
    .map((key, index) => ({ key, index, hash: stringHash(key) }))
    .filter(({ index }) => slots[index]! < 0)
    .sort((a, b) => a.hash - b.hash || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { key, index, hash } of fresh) {
    const slot = freeSlot(hash % REPO_HUES, taken);
    taken.add(slot);
    given.set(key, slot);
    slots[index] = slot;
  }
  return slots;
}
