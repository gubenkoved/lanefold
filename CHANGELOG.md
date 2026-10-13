# Changelog

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
