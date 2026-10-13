/** Object names: SHA-1 (40 hex digits) or SHA-256 (64) commit, tree and blob ids. */

/** A full object name: 40 or 64 lowercase hex digits, never an abbreviation. */
export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

/** A revision as the UI names it: a full object name shortened to 8 digits, a ref name as it is. */
export function displayRev(rev: string): string {
  return isObjectId(rev) ? rev.slice(0, 8) : rev;
}
