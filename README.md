# Lanefold

Lanefold is a Git client for VS Code built around the commit graph. You browse history, run
operations, edit commits and review changes from the graph. Before an operation runs, Lanefold
shows the git commands it will use, and every change it makes to the repository can be undone.

![Lanefold in VS Code: the commit graph with the branches pane, and uncommitted changes staged hunk by hunk](https://gist.githubusercontent.com/gubenkoved/66fff765499dc9a41fddfc132bbf5861/raw/screenshot.png)

## Features

### History

- A commit graph that streams history from git and stays responsive with millions of commits.
  Its author, date and hash columns can be switched off and moved: right-click or drag a column
  heading. Two more columns are off until you switch them on: the files each commit added, changed
  and removed, and its lines added and removed. git is asked for them only while they show, and
  only for the commits in view.
- Views as tabs: all branches, the current branch, local branches or the branches you choose;
  file, folder and line history; comparisons between two refs; stashes, the reflog and
  statistics.
- Details for one commit, two commits or a selection, with changed files that open in VS Code's
  diff editor. A commit's details list the branches and tags that contain it.
- Search by text, author (`@name`), hash (`#1a2b3c`), path (`file:`), message (`message:`) and
  date (`after:`, `before:`). Matches are highlighted, or the graph is filtered down to them.
- Blame annotations with an age heat bar (their width and how they name authors and dates are
  settings), and history for a file or a range of lines.
- The history of every open repository in one graph.

### Operations

- Checkout, branches, tags, reset, revert, cherry-pick, merge and rebase, from menus or by
  dragging commits and branches in the graph.
- A review before each operation: the git commands with an explanation of every flag, the refs
  that move, commits that would be left behind, and conflicts predicted with `git merge-tree`
  without touching the working tree.
- Undo and Redo for every operation that changes the repository, rebases included. Uncommitted
  work that an operation could lose is saved first and restored exactly.
- Uncommitted changes that are in the way of a checkout, revert or cherry-pick can be carried
  over.
- Conflicts name both sides by branch, open in VS Code's merge editor, and are continued, skipped
  or aborted from a banner.

### History editing

- An interactive rebase editor in the graph: reorder, squash, fix up, reword, drop, stop to edit
  and split commits, with the keyboard or by drag and drop.
- A dry run of each arrangement that predicts conflicts and empty commits before anything runs.
- Amend any recent commit with the staged changes by dragging them onto it.
- Split a commit by committing its changes in parts.

### Changes and commits

- Stage and unstage files, hunks or single lines in the details pane.
- Commit, amend and sign off from the commit form; drafts are kept per repository.
- Discard files, hunks or lines, with Undo.
- Save, apply, pop and drop stashes.

### Branches and remotes

- A branches pane with folders, remotes, tags, favorites and ahead/behind counts. Its checkboxes
  choose what the view shows: branches left out, or added to the current branch or to the ones
  chosen.
- Fetch, pull and push, with results in plain words. Force pushes, and deleting or renaming
  branches on a remote, always use `--force-with-lease`.
- Delete branches locally, from their remote, or both at once; rename a branch here and on its
  remote; set, change or stop the upstream a branch tracks; fast-forward a branch without checking
  it out; push a branch to any remote; fetch and prune the remote branches deleted on the remote.
- Clean up after merged pull requests: the branches whose upstream is gone are deleted all at
  once, after a review that lists each, and Undo brings them back.
- Add, edit and remove remotes. Credential prompts appear as VS Code input boxes.
- A status bar item with the checked-out branch and its commits to push and to pull. Click it to
  switch branches: recently used ones come first, each with its last commit and how far ahead or
  behind it is. While a merge, rebase, cherry-pick, revert, patch or bisect is stopped, it says
  so, with the number of conflicts.
- Switch Branch, Create Branch, Delete Branch, Delete Branches Whose Upstream Is Gone, Fetch,
  Pull, Push, Stash Changes and Compare Branches from the Command Palette, reviewed and undoable
  like Lanefold's own buttons.

![The Switch Branch picker over the Lanefold graph, with recent branches first, and the branch in the status bar](https://gist.githubusercontent.com/gubenkoved/66fff765499dc9a41fddfc132bbf5861/raw/switch-branch.png)

### Code hosts

- Lanefold reads which code host each remote is on: GitHub, GitLab, Bitbucket, Azure DevOps,
  Gitea and Forgejo, and self-hosted servers named after them. Remote URLs are read as git uses
  them, with `insteadOf` rewrites and SSH host aliases; other servers can be named in a setting.
- Pointing at a commit's hash in its details offers the commit there: open it, or copy its link.
  Menus open commits, comparisons, branches, tags and changed files.
- A link goes to a remote that has the commit; for a commit not pushed yet, Lanefold says so
  instead.
- Issue references (`#12`, GitLab's `!12`) and web addresses in commit messages are links, and
  so are references set up like GitHub's autolinks (`PROJ-12`).
- In the editor, Copy Permalink and Open on Remote link the selected lines as of the newest
  commit a remote has.

### More

- Statistics for a branch or the whole repository: activity over time, a weekday by hour punch
  card, contributors, the most changed files and folders, languages and line counts (for the
  latest 20,000 commits, or for every commit).
- Worktrees, submodules, visual bisect, patches, reflog recovery, clone and init.
- The Git Console lists every git command Lanefold runs, with its output and timing.

Lanefold follows the VS Code theme, including high contrast, and works entirely from the
keyboard.

## Getting started

Lanefold needs VS Code 1.100 or later and git 2.30 or later. Conflict prediction needs git 2.40
or later.

Open it with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd> (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>
on macOS) or run **Lanefold: Open** from the Command Palette. Every command is under
**Lanefold:** there.

### Keyboard

| Where          | Keys                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph          | <kbd>↑</kbd> <kbd>↓</kbd> select, <kbd>←</kbd> <kbd>→</kbd> go to a child or the parent, <kbd>Enter</kbd> open the changes, <kbd>Shift</kbd>+<kbd>F10</kbd> menu, <kbd>F2</kbd> reword                                           |
| Graph          | <kbd>Ctrl</kbd>+<kbd>F</kbd> or <kbd>/</kbd> search, <kbd>F3</kbd> next match, <kbd>Ctrl</kbd>+<kbd>C</kbd> copy hashes, <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> redo                   |
| History editor | <kbd>P</kbd> pick, <kbd>R</kbd> reword, <kbd>E</kbd> edit, <kbd>I</kbd> split, <kbd>S</kbd> squash, <kbd>F</kbd> fixup, <kbd>D</kbd> drop, <kbd>Alt</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>Ctrl</kbd>+<kbd>Enter</kbd> apply |
| Branches       | <kbd>Space</kbd> show or hide in the view, <kbd>Enter</kbd> go to the commit, <kbd>F2</kbd> rename, <kbd>Delete</kbd> delete                                                                                                     |
| Column heading | <kbd>←</kbd> <kbd>→</kbd> the next heading, <kbd>Alt</kbd>+<kbd>←</kbd> <kbd>→</kbd> move the column, <kbd>Shift</kbd>+<kbd>F10</kbd> menu, <kbd>↓</kbd> back to the commits                                                     |
| Tabs           | <kbd>Alt</kbd>+<kbd>←</kbd> <kbd>→</kbd> move, <kbd>F2</kbd> rename, <kbd>Delete</kbd> close                                                                                                                                     |
| Blame          | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>[</kbd> annotate the previous revision, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>,</kbd> back, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>.</kbd> forward                                                |

<kbd>Shift</kbd>+click selects a range of commits and <kbd>Ctrl</kbd>+click adds one. In the history
editor, dropping a commit onto another squashes it (<kbd>Alt</kbd> for fixup).

### Settings

| Setting                           | Default       | What it does                                                                        |
| --------------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `lanefold.confirm`                | `destructive` | When to review an operation first: `always`, `destructive` or `never`.              |
| `lanefold.graph.style`            | `curved`      | Curved or angular lanes.                                                            |
| `lanefold.graph.density`          | `comfortable` | Row height: `compact`, `comfortable` or `spacious`.                                 |
| `lanefold.graph.colors`           | none          | Your own lane colors (CSS colors) instead of the theme's palette.                   |
| `lanefold.log.order`              | `topo`        | Commit order of new views: `topo` keeps each branch together, `date` sorts by date. |
| `lanefold.dateFormat`             | `relative`    | Relative or absolute dates in the graph.                                            |
| `lanefold.views.defaultTabs`      | All, HEAD     | The tabs a repository opens with the first time (HEAD shows the current branch).    |
| `lanefold.animations`             | `full`        | `full`, `reduced` or `off`. The system's reduced motion setting always applies.     |
| `lanefold.avatars.gravatar`       | off           | Load author avatars from Gravatar instead of showing initials.                      |
| `lanefold.blame.ignoreWhitespace` | off           | Blame with `-w`: whitespace-only changes do not count.                              |
| `lanefold.blame.detectMoves`      | off           | Blame with `-M`: lines moved within a file keep their original author.              |
| `lanefold.blame.width`            | 28            | Width of the blame annotations, in characters.                                      |
| `lanefold.blame.author`           | `full`        | How annotations name authors: `full`, `first`, `firstInitial`, `initials`, `email`… |
| `lanefold.blame.date`             | `auto`        | How annotations date changes: `auto`, `relative`, `date`, `iso` or `none`.          |
| `lanefold.blame.heat`             | on            | Tint annotations by the age of the change.                                          |
| `lanefold.links.hosts`            | none          | Self-hosted code hosts, by host name: `{ "git.example.com": "gitlab" }`.            |
| `lanefold.links.autolinks`        | none          | More issue references to link: `[{ "prefix": "PROJ-", "url": "https://…/<num>" }]`. |
| `lanefold.git.path`               | none          | The git executable. By default, the one VS Code's Git extension uses, then `PATH`.  |

## Development

Requirements: Node.js 22 or later and git 2.30 or later.

```bash
npm install
npm run build        # the extension (esbuild) and the webview (Vite)
npm run typecheck
npm run lint
npm test             # unit tests and tests against real git repositories
```

Press <kbd>F5</kbd> in VS Code ("Run Lanefold") to start an Extension Development Host. After
`npm run demo-repo -- out/demo`, "Run Lanefold (demo repository)" opens a sample repository with
branches, merges, tags and a remote.

### Browser harness

The webview also runs in a browser, connected to the real backend over a WebSocket:

```bash
npm run demo-repo -- out/demo
npm run build:webview
npm run harness -- --repo out/demo/aurora
# open http://127.0.0.1:5177/?theme=light-modern
```

Repeat `--repo` (or `&repo=` in the URL) to open several repositories at once. The themes
(`dark-modern`, `light-modern`, `dark-hc`, `light-hc`) are snapshots of the variables VS Code
gives webviews, captured by the integration tests with `LANEFOLD_CAPTURE_THEMES=dev/harness/themes`.

### Tests

| Command               | What it covers                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `npm run test:unit`   | Parsers, RPC, graph layout, planners and view logic                                           |
| `npm run test:git`    | Core services against throwaway repositories built from fixtures                              |
| `npm run test:e2e`    | Playwright against the harness, including an accessibility audit of every view in four themes |
| `npm run test:perf`   | Performance budgets: a long history, very many refs, huge commits and working trees           |
| `npm run test:vscode` | The extension in a real VS Code (on Linux, run it with `xvfb-run -a`)                         |

`npm run package` builds the VSIX, and `npm run logo` renders the PNG sizes of the logo from
`media/logo/lanefold.svg` and the editor tab's icons (a dark and a light one) from the panel
glyph, `media/lanefold.svg`.

The README's screenshots are in `media/`, and copies are in a
[secret gist](https://gist.github.com/gubenkoved/66fff765499dc9a41fddfc132bbf5861) that the
README links to, since the Marketplace cannot load images from this private repository. After
changing a screenshot, push it to the gist too (`git clone https://gist.github.com/66fff765499dc9a41fddfc132bbf5861.git`).

### Architecture

```
src/shared     environment-independent code: protocol, models, RPC, graph topology and layout
src/core       Node only: git runner, repository model, operations and their journal, backend
src/extension  VS Code integration: activation, webview hosts, watchers, blame
src/webview    React app: graph, tabs and views, review sheet, history editor
dev/harness    browser harness server and VS Code theme snapshots
dev/perf       synthetic repositories for the performance budgets
```

ESLint enforces the module boundaries: `src/shared` imports neither Node nor VS Code, and the
webview reaches the extension only through the typed RPC.

## License

[MIT](LICENSE)
