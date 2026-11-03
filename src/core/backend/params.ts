/*
 * Checks for the values a webview sends with a request. They arrive as JSON from another
 * process: a value of the wrong type fails here, with a plain message, instead of reaching git.
 */

import { isObjectId } from '../../shared/oid';
import { assertRevision } from '../git/args';
import { isFilePath } from '../repo/lineStaging';

/** A count from 1 to `max` (fractions round down); `fallback` when none was given. */
export function checkCount(value: unknown, max: number, fallback = max): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`Not a count: ${String(value)}.`);
  return Math.min(max, Math.max(1, Math.floor(value)));
}

/** A revision (an object name, a ref name, `a...b`), never one git would read as an option. */
export function checkRev(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`Not a revision: ${String(value)}.`);
  return assertRevision(value);
}

/** A full object ID (a commit's hash, as git prints it). */
export function checkObjectId(value: unknown): string {
  if (!isObjectId(value)) throw new Error(`Not an object ID: ${String(value)}.`);
  return value;
}

/** One of `allowed`; `fallback` when none was given. */
export function checkOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value as T)) throw new Error(`Not one of ${allowed.join(', ')}: ${String(value)}.`);
  return value as T;
}

/** File paths as git lists them (see {@link isFilePath}). */
export function checkFilePaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every(isFilePath)) throw new Error('Not a list of file paths.');
  return value;
}
