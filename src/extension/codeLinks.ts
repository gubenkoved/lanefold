import * as path from 'node:path';
import * as vscode from 'vscode';
import { linesAt } from '../core/blame/blame';
import { revisions } from '../core/git/args';
import { pushedCommit, readCodeHosts, remotesContaining } from '../core/repo/codeHosts';
import type { RepositoryRegistry } from '../core/repo/registry';
import type { Repository } from '../core/repo/repository';
import { linkUrl, type CodeHost } from '../shared/codeHosts';
import { locateFile } from './fileLocation';
import { readSettings } from './vscodePlatform';

/*
 * Links to the code host from the editor: the selected lines of a file (Lanefold: Copy Permalink,
 * Open on Remote) and a blamed line's commit. A link points at a commit a remote has, so it
 * shows what it says to anyone who opens it.
 */

/** Hosts per repository for a little while: hovers ask for them line after line. */
const hostCache = new Map<
  string,
  { readonly at: number; readonly key: string; readonly hosts: Promise<CodeHost[]> }
>();
const HOSTS_TTL_MS = 30_000;

/** The repository's code hosts, in the order links prefer them. */
export function hostsOf(repo: Repository): Promise<CodeHost[]> {
  const settings = readSettings().links;
  const key = JSON.stringify(settings.hosts);
  const cached = hostCache.get(repo.id);
  if (cached && cached.key === key && Date.now() - cached.at < HOSTS_TTL_MS) return cached.hosts;
  const hosts = readCodeHosts(repo, settings).catch(() => []);
  hostCache.set(repo.id, { at: Date.now(), key, hosts });
  return hosts;
}

/**
 * Keeps the `lanefold.links.hosted` context key saying whether the active editor's file is in a
 * repository on a code host: the editor's menu offers links only there.
 */
export function trackHostedEditor(registry: RepositoryRegistry): vscode.Disposable {
  let generation = 0;
  const update = async () => {
    const current = ++generation;
    const editor = vscode.window.activeTextEditor;
    const location = editor && locateFile(registry, editor.document.uri);
    const hosted = location ? (await hostsOf(location.repo)).length > 0 : false;
    if (current === generation)
      await vscode.commands.executeCommand('setContext', 'lanefold.links.hosted', hosted);
  };
  void update();
  const repos = registry.onDidChangeRepos(() => void update());
  const changes = registry.onDidChangeRepo(({ repo, kinds }) => {
    // A remote added or its URL set.
    if (!kinds.has('config')) return;
    hostCache.delete(repo.id);
    void update();
  });
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveTextEditor(() => void update()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('lanefold.links')) void update();
    }),
    { dispose: () => repos.dispose() },
    { dispose: () => changes.dispose() },
  );
}

/** Where a link goes (and what to tell about it), or why there is none. */
export type EditorLink =
  { readonly url: string; readonly host: CodeHost; readonly warning?: string } | { readonly reason: string };

const short = (sha: string) => sha.slice(0, 8);

function noHost(repo: Repository): string {
  return `No remote of ${path.basename(repo.root)} is on a code host Lanefold knows (GitHub, GitLab, Bitbucket, Azure DevOps, Gitea). A self-hosted one can be named in the lanefold.links.hosts setting.`;
}

function notPushed(hosts: readonly CodeHost[], what: string): string {
  const [only] = hosts;
  return hosts.length === 1 && only
    ? `${what} is not on ${only.name} yet: no branch of ${only.remote} has it.`
    : `${what} is not on a remote yet.`;
}

/** The first host (in the order links prefer) whose remote has `sha`. */
async function hostHaving(
  repo: Repository,
  hosts: readonly CodeHost[],
  sha: string,
): Promise<CodeHost | undefined> {
  const remotes = await remotesContaining(
    repo,
    sha,
    hosts.map((host) => host.remote),
  );
  return hosts.find((host) => remotes.has(host.remote));
}

/** A link to a commit on the code host, or why there is none. */
export async function commitLink(repo: Repository, sha: string): Promise<EditorLink> {
  const hosts = await hostsOf(repo);
  if (hosts.length === 0) return { reason: noHost(repo) };
  const host = await hostHaving(repo, hosts, sha);
  const url = host && linkUrl(host, { kind: 'commit', sha });
  return host && url ? { url, host } : { reason: notPushed(hosts, `Commit ${short(sha)}`) };
}

/**
 * A link to the selected lines of the editor's file. The lines of a file in the working tree are
 * looked up in the newest commit a remote has (HEAD once pushed): edits since shift them, and
 * the link says how they read there.
 */
export async function editorLink(
  registry: RepositoryRegistry,
  editor: vscode.TextEditor,
): Promise<EditorLink> {
  const location = locateFile(registry, editor.document.uri);
  if (!location?.path) return { reason: 'This file is not in a repository Lanefold has open.' };
  const { repo, path: file } = location;
  const hosts = await hostsOf(repo);
  if (hosts.length === 0) return { reason: noHost(repo) };
  const { selection } = editor;
  let start = selection.start.line + 1;
  let end = selection.end.line + 1;
  // A selection of whole lines ends at the start of the next one.
  if (end > start && selection.end.character === 0) end -= 1;

  let sha: string | undefined;
  let warning: string | undefined;
  if (location.rev) {
    // A file as a commit has it: its lines are that commit's.
    const { stdout } = await repo.git(
      ['rev-parse', '--verify', '--quiet', ...revisions(`${location.rev}^{commit}`)],
      {
        readOnly: true,
        background: true,
        label: 'Read the revision',
        okExitCodes: [0, 1],
      },
    );
    sha = stdout.trim() || undefined;
    if (!sha) return { reason: `${location.rev} is not a commit.` };
  } else {
    sha = await pushedCommit(repo);
    if (!sha) return { reason: notPushed(hosts, 'Nothing on this branch') };
    const exists = await repo.git(['cat-file', '-e', ...revisions(`${sha}:${file}`)], {
      readOnly: true,
      background: true,
      label: 'Find the file',
      okExitCodes: [0, 1, 128],
    });
    if (exists.exitCode !== 0)
      return {
        reason: `${path.basename(file)} is not in ${short(sha)}, the newest commit on a remote, yet.`,
      };
    const unsaved = editor.document.isDirty ? editor.document.getText() : undefined;
    const mapped = await linesAt(repo, sha, file, start, end, unsaved);
    if (mapped.changed)
      warning = `The selected lines have changed since ${short(sha)}, the newest commit on a remote: the link shows them as they are there.`;
    ({ start, end } = mapped);
  }
  const host = await hostHaving(repo, hosts, sha);
  if (!host) return { reason: notPushed(hosts, `Commit ${short(sha)}`) };
  const url = linkUrl(host, { kind: 'file', sha, path: file, lines: { start, end } });
  return url ? { url, host, warning } : { reason: `${host.name} has no page for it.` };
}
