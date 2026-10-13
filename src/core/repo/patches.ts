import { OBJECT_ID } from '../../shared/oid';
import { revisions } from '../git/args';
import type { Repository } from './repository';

/**
 * The commits as one mbox patch (`git format-patch --stdout`), oldest first so it applies in
 * order. `shas` come newest first, as the graph lists them. Bytes, not text: file contents
 * need not be UTF-8.
 */
export async function formatPatches(repo: Repository, shas: readonly string[]): Promise<Buffer> {
  if (shas.length === 0) throw new Error('Choose the commits to export.');
  const parts: Buffer[] = [];
  for (const sha of [...shas].reverse()) {
    if (!OBJECT_ID.test(sha)) throw new Error(`Not a commit hash: ${sha}`);
    const { stdout } = await repo.gitBuffer(['format-patch', '--stdout', '-1', ...revisions(sha)], {
      readOnly: true,
      label: 'Create patch',
    });
    parts.push(stdout);
  }
  return Buffer.concat(parts);
}

/** "1a2b3c4d-fix-the-login-form.patch", or "3-commits-1a2b3c4d.patch". */
export async function patchFileName(repo: Repository, shas: readonly string[]): Promise<string> {
  const newest = shas[0]!.slice(0, 8);
  if (shas.length > 1) return `${shas.length}-commits-${newest}.patch`;
  const { stdout } = await repo.git(['log', '-1', '--format=%s', ...revisions(shas[0]!)], {
    readOnly: true,
    background: true,
    label: 'Patch file name',
  });
  const slug = stdout
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${newest}${slug ? `-${slug}` : ''}.patch`;
}
