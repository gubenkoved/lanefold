import { readFile } from 'node:fs/promises';

/** A text file's content, trimmed; undefined when it cannot be read. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return undefined;
  }
}
