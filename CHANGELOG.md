# Changelog

## 0.4.0

- Rebase onto a branch with the commits arranged first. The history editor opens on the commits
  that branch lacks, to drop, squash, reorder or reword before they are replayed
  (`git rebase -i --onto`).
  - It opens from Rebase Interactively onto… in the Command Palette, from Rebase interactively…
    under each Rebase in the graph's menus, and from Arrange commits first… in the review of a
    plain rebase.
  - The command's picker lists recently used branches first, then the other branches by their
    last commit, then the remote branches. A tag or a commit hash can be typed.
  - Commits the target already has as other commits start out dropped, and say so: after an
    upstream was rewritten, they are the ones that are not the branch's own.
  - Conflicts are predicted against the target, step by step, and Undo puts the branch back.
  - A branch that already contains the target edits its commits after it, as before. One with no
    commits of its own is moved forward.
- Commands go to the Lanefold view in use. From the Command Palette, they always opened the
  bottom panel, with Lanefold in front in an editor tab too.
  - A view on screen takes them: the one used last when the panel and an editor tab both show.
  - With none on screen, the view used last is brought forward. The panel opens only when there
    is neither.
  - Lanefold: Open and its shortcut follow the same rule.
- A hunk's bar stays on one line as lines are picked. It wrapped when a button's label grew, and
  moved the lines under the mouse in the middle of a drag. Its range gives way, whole on hover.
- Copy Permalink, Open on Remote and a blamed commit's page work right after a remote is added or
  its URL set. For up to half a minute they said no remote is on a code host.

## 0.3.0

- Two more columns in the commit graph, off until you switch them on (right-click a column
  heading, or the view options): Files, the files each commit added, changed and removed, and
  Lines, its lines added and removed.
  - Large counts are shortened (`1.4K`, `1.5M`) and each keeps a place of its own, so rows line
    up. Pointing at a cell shows the exact counts.
  - A merge is counted against its first parent, as its list of changed files is. A renamed file
    is one file changed.
  - git is asked for them only while they show, for the commits in view, once the graph stops
    scrolling. Lines take git many times longer than files: they are read apart, and only while
    their own column shows.
  - A narrow graph leaves these columns out first, and then reads nothing for them.
- While a commit is split, the banner's Commit part 1… opens the details pane when it is closed.
  The button did nothing then.
  - From a tab without the uncommitted changes (a branch's or a file's history), it goes to a tab
    that has their row.
  - With two log tabs, the cursor goes to the commit box of the tab in front.
  - A search that filters the uncommitted changes out says so, with the way to them.

## 0.2.1

- Clearer in dark and high contrast themes:
  - A toggle's chosen option is lighter than the others in dark themes. It had the page's own
    colour and looked sunk into the control.
  - The editor tab's icon shows. It was black: hard to see on a dark tab, and invisible on a high
    contrast one.
  - The repository picker and the fetch, pull and push buttons have an edge, as the toolbar's
    other controls do. In a high contrast theme they had no outline at all.
  - In high contrast themes, a pressed button (a pane shown, view options changed) looks pressed.
- In the statistics, the accent bar on the row of the author they show runs straight. It bent round
  the row's rounded corners.

## 0.2.0

- Links to the code host: Lanefold reads which host each remote is on (GitHub, GitLab, Bitbucket
  Cloud and Server, Azure DevOps, Gitea and Forgejo), from its URL as git uses it: `insteadOf`
  rewrites apply and SSH host aliases are looked up. A link goes to a remote that has the commit,
  `upstream` first (in a fork, the original repository).
  - Pointing at a commit's hash in its details, or reaching it with <kbd>Tab</kbd>, offers the
    commit there: Open on GitHub, Copy link, Copy hash. For a commit no remote has yet, it says so
    instead.
  - Menus open commits, the comparison of two commits, branches (where their upstream is), tags
    and a commit's changed files on the host, and copy their links. The menu's footer shows the
    address.
  - Issue references in commit messages (`#12`, `GH-12`, `owner/repo#12`, GitLab's `!12`) and web
    addresses are links. They read as the text around them until pointed at.
  - In the editor, Copy Permalink and Open on Remote link the selected lines, or the cursor's, as
    of the newest commit a remote has: edits since then shift them, and lines that changed are
    pointed out. The editor's menu offers them where the file's repository is on a code host.
  - The blame hover opens a line's commit on the host.
  - New settings: `lanefold.links.hosts` names servers Lanefold cannot tell by name (a
    self-hosted GitLab, say), with their web address where it differs, and
    `lanefold.links.autolinks` links more references, as GitHub's autolinks do (`PROJ-12`).
- After a commit much newer than the others, a refresh no longer hides the other branches for a
  moment.

## 0.1.4

- The branches pane has a checkbox for each branch, remote branch and tag: checked, its commits
  are in the view.
  - In a view of all branches or of the local ones, unchecking a branch leaves it out (as hiding
    it did). In a view of the current branch, checking another adds it: the current branch and
    `main` together, say. A view of the local branches takes remote branches and tags the same way,
    and a view of one branch (Show only this branch) takes more branches next to it.
  - <kbd>Space</kbd> checks or unchecks the branch in focus. Choosing a branch the view does not
    show offers to show it there.
- New view → Several branches… opens a view of the branches and tags you check.
- A commit's details list the branches and tags that contain it: the current branch and the
  trunk first, then the other branches and the remote branches, and the tags, the oldest first
  (the first release to have the commit). Choosing one goes to its commit.
- The graph's columns can be switched off and on and moved: right-click a column heading, drag it
  sideways, or View options → Columns. The choice applies to every graph and is kept.
  - Column headings work from the keyboard: <kbd>Tab</kbd> reaches them, <kbd>←</kbd>
    <kbd>→</kbd> go between them, <kbd>Alt</kbd>+<kbd>←</kbd> <kbd>→</kbd> moves a column and
    <kbd>Shift</kbd>+<kbd>F10</kbd> opens their menu.
  - A narrow graph still leaves out the hash, then the author, and finds room for one you keep
    when you switch another off.
- Statistics:
  - Changed lines can be counted for every commit, not only the latest 20,000: Count all, in the
    notice under the summary. The choice is kept with the tab; while it runs, Latest 20,000 only
    goes back.
  - The contributors and hotspots lists keep their columns lined up: every bar starts at the same
    place and compares on one scale, whatever the numbers in its row.
  - Large numbers are shortened where room is tight (295K, 6.23M), with the exact number on hover.
  - A contributor whose lines are not counted shows "—" instead of "+0 −0", and says why: not
    counted yet, older than the commits counted, or only merges. Partly counted ones say how many
    of their commits are counted.
- Blame:
  - Empty lines no longer show a stray line in their annotation (VS Code drew the indentation
    guide there, as if the annotation were not).
  - New settings: the width of the annotations (`lanefold.blame.width`), how they name authors
    (`lanefold.blame.author`: the whole name, the first name, "Maneeshi S.", "M. Sharma",
    initials or the email's name) and date changes (`lanefold.blame.date`: in words, the day, ISO
    dates or none), and whether they are tinted by age (`lanefold.blame.heat`).

## 0.1.3

- Branches can be deleted from their remote: from a remote branch's menu (in the graph or the
  branches pane), with <kbd>Delete</kbd> in the branches pane, or with Delete Branch… in the
  Command Palette.
  - It is always reviewed first: Undo cannot bring a branch back on a remote. The review names
    the commits only that branch has, and warns about the remote's default branch.
  - It uses `--force-with-lease`: commits someone pushed to the branch since your last fetch are
    never deleted unseen.
  - A branch the remote had deleted already (a merged pull request's, say) is forgotten here too.
- A branch and its remote branch can be deleted together: Delete branch and origin/… in the
  branch's menu, or the checkbox in the review of a deletion. Undo brings the branch back.
- A branch with an upstream can be renamed on its remote too: Also rename it on origin, in the
  review of the rename. It is published under the new name, which it tracks from then on, and the
  old name is deleted from the remote, both with `--force-with-lease`. Undo renames it back here
  only.
  - The review refuses a name the remote has already, and a rename that would drop commits only
    the remote branch has (pull them first).
  - If the new name cannot be published, the branch keeps its old name here too. A remote that had
    deleted the old name already is no trouble.
- Undo of a branch deletion brings back the branch's upstream too (git deletes it with the
  branch).
- The upstream of a branch can be set, changed or removed from its menu (Set upstream…, Stop
  tracking …). A branch made without one can then pull and push.
- A branch that is not checked out can be fast-forwarded to its upstream from its menu.
- A branch can be pushed to any remote from its menu, not only to its upstream's.
- Fetch and prune, in a remote's menu: remote branches deleted on the remote go here too.
- The branches whose upstream is gone (deleted on the remote, as a merged pull request's often
  is) can be deleted all at once: Delete branches whose upstream is gone… in the remote's menu,
  in the Branches section's menu, in the menu of such a branch, or in the Command Palette.
  - It is always reviewed first. The review lists each branch, deleted with `-d` when its commits
    are all in the current branch (or its upstream) and with `-D` otherwise, and counts the
    commits that would be left on no branch.
  - The branch checked out, and branches checked out in other worktrees, stay; the review says
    so.
  - Undo brings them all back, with their upstreams.
- The graph, the branches pane and the pull and push buttons notice a branch's upstream changing
  outside Lanefold.

## 0.1.2

- A status bar item shows the checked-out branch and how it stands against its upstream (commits
  to push and to pull, as of the last fetch). Click it to switch branches. While git is stopped
  in a merge, rebase, cherry-pick, revert, patch or bisect, it says so, with the number of
  conflicts, and opens Lanefold.
- New commands in the Command Palette:
  - Switch Branch… lists recently used branches first, then branches by latest commit, then
    remote branches, each with its last commit and how far ahead or behind it is.
  - Create Branch…, Fetch, Pull, Push, Stash Changes… and Compare Branches….
  - They run the way Lanefold's own buttons do: reviewed when needed, with Undo afterwards.
- Lanefold starts after VS Code has finished starting up, so the status bar item is there from
  the start.

## 0.1.1

- Operations no longer get stuck half-done when git cannot replace a file because another
  program has it open (common on Windows):
  - A rebase, cherry-pick or revert step that fails this way shows the reason in the banner and
    offers Retry. Retry, Skip and Abort first clear what the step left behind, saving anything
    else as a stash.
  - Other operations that fail half-way (merge, pull, reset, stash, discard and others) put the
    files git had already changed back as they were, so the operation can simply be run again.
    The error offers Retry, and Undo when something changed.
  - A checkout that could not update a file names it and offers to update it once it is free.
    Undo of that checkout works even while the file is still open.
- Continue, Skip and Abort that fail are reported as errors, with git's reason in plain words.
- Discarding or restoring files no longer reports "Nothing changed".
- Rewording a commit in a short panel brings the message box into view.
- The Lanefold output log no longer reports expected exit codes as errors.

## 0.1.0

The first release.

- A commit graph with views as tabs, search, commit details and VS Code diffs, and one graph for
  several repositories.
- Checkout, branches, tags, reset, revert, cherry-pick, merge and rebase from the graph, each
  reviewed before it runs and undoable afterwards.
- An interactive rebase editor: reorder, squash, fix up, reword, drop, edit and split commits,
  with a dry run that predicts conflicts.
- Staging of files, hunks and lines, commits, amends and stashes.
- A branches pane, remotes, fetch, pull and push, and credential prompts.
- Blame, file history and line history.
- Statistics, worktrees, submodules, the reflog, bisect, patches, clone and init.
