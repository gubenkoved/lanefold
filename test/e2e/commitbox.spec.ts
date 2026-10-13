import { expect, test, type Page } from '@playwright/test';
import { harnessUrl } from './paths';
import { copyDemo, git, graphRow } from './support';

/** A private copy of the demo repository with nothing staged (src/dashboard.css modified). */
function unstagedCopy(): string {
  const repo = copyDemo();
  git(repo, 'reset', '-q');
  return repo;
}

/**
 * Holds back the answers to `repo.worktreeChanges` (the file lists of the details pane), as a
 * slow disk or a large repository would: the lists then trail what git did for a while.
 */
async function slowFileLists(page: Page, delayMs: number): Promise<void> {
  await page.routeWebSocket(/\/rpc/, (socket) => {
    const server = socket.connectToServer();
    const held = new Set<number>();
    socket.onMessage((message) => {
      if (typeof message === 'string' && message.includes('"repo.worktreeChanges"')) {
        const request = JSON.parse(message) as { kind: string; id: number; method: string };
        if (request.kind === 'req' && request.method === 'repo.worktreeChanges') held.add(request.id);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message === 'string' && message.startsWith('{"kind":"res"')) {
        const { id } = JSON.parse(message) as { id: number };
        if (held.delete(id)) {
          setTimeout(() => socket.send(message), delayMs);
          return;
        }
      }
      socket.send(message);
    });
  });
}

test('commits right after staging, before the file lists catch up', async ({ page }) => {
  const repo = unstagedCopy();
  const before = git(repo, 'rev-parse', 'HEAD');
  await slowFileLists(page, 1500);
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Uncommitted changes').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  const css = details.getByRole('listitem').filter({ hasText: 'dashboard.css' }).first();
  await css.hover();
  await css.getByRole('button', { name: 'Stage' }).click();
  // No waiting for the lists: the message and Ctrl+Enter right away.
  const message = details
    .getByRole('form', { name: 'Commit' })
    .getByRole('textbox', { name: 'Commit message' });
  await message.fill('Tweak the grid gap');
  await message.press('Control+Enter');

  await expect.poll(() => git(repo, 'log', '-1', '--format=%s')).toBe('Tweak the grid gap');
  expect(git(repo, 'rev-parse', 'HEAD~1')).toBe(before);
  expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/dashboard.css');
  await expect(page.getByRole('status')).not.toContainText('Stage the changes to commit first');
});

test('says what is missing once the lists caught up, when nothing is staged', async ({ page }) => {
  const repo = unstagedCopy();
  await page.goto(harnessUrl({ repo }));
  await graphRow(page, 'Uncommitted changes').click();
  const details = page.getByRole('complementary', { name: 'Commit details' });
  const box = details.getByRole('form', { name: 'Commit' });
  await box.getByRole('textbox', { name: 'Commit message' }).fill('Nothing staged');
  await expect(box.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  await box.getByRole('textbox', { name: 'Commit message' }).press('Control+Enter');
  await expect(page.getByRole('status')).toContainText('Stage the changes to commit first');
  expect(git(repo, 'log', '-1', '--format=%s')).toBe('Add dark mode toggle');
});
