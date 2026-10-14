# Changelog

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
