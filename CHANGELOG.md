# Changelog

## Unreleased

- Conflicts: when an operation stops with conflicts (merge, rebase, cherry-pick, revert, pull, update, checkout, Smart Merge / Smart Checkout restoring local changes, Unstash, Unshelve) the Conflicts dialog opens right away, like IntelliJ's GitConflictResolver; the notification ("Local changes were restored with conflicts", "Conflicts were not resolved during unstash", …) only appears when conflicts are left after the dialog is closed. Restored stash / shelf conflicts use IntelliJ's texts ("Uncommitted changes that were saved before merge have conflicts with files from feature", "Uncommitted changes from the stash" / "Changes from feature") and the saved changes stay on the left. Once the conflicts of a merge or rebase are all resolved, the merge is committed and the rebase continues. Smart Merge no longer tries to unstash in the middle of a conflicted merge: the changes are restored after the merge is finished.
- *Resolve Conflicts… (IdeaGitTool)* in the editor title and as a CodeLens above the first conflict marker of a file git reports unmerged.
- New setting `ideagittool.merge.handleConflicts` (`ask` / `always` / `never`): asked once per workspace whether IdeaGitTool should handle conflicts instead of VS Code's built-in conflict UI; with your consent it turns off `merge-conflict.codeLens.enabled`, `merge-conflict.decorators.enabled` and `git.mergeEditor`. Command *Restore VS Code's Built-in Merge Conflict UI* puts them back.
- File type icons for Go, Rust, Python, Ruby, PHP, Kotlin (kt / kts), Scala, Dart, Lua, R, Svelte and Elixir.

- Git log: the selected commit stays clearly visible, also when the log has no focus and in themes with low-contrast selection colors such as Tokyo Night Storm (accent bar on the left, selection color mixed with the theme accent), and the current-branch highlight is lighter and only shown when the log also contains commits outside the current branch, like IntelliJ.

## 0.3.0

- New **Branches** tab in the Commit tool window (next to Commit / Shelf / Stash) with the content and layout of IntelliJ's branches popup: search, Fetch, settings, Update Project… / Commit… / Push…, New Branch…, Checkout Tag or Revision…, Recent / Local / Remote / Tags grouped by directory, favorites, branch submenus. `Branches…` (Ctrl+Shift+`) opens it.
- The status bar widgets (Update Project, Push, branch, merge/rebase actions) and the `ideagittool.statusBar.enabled` setting are removed; their actions are in the Branches tab, the Commit tab banner and the Git menu.
- The Git log opens in the **Git** panel at the bottom by default (`ideagittool.log.showInEditor` is now off by default).
- Clickable elements in all views and dialogs show the hand cursor.
- Inline blame after the caret line ("author, date, time • subject"), like IntelliJ; setting `ideagittool.inlineBlame.enabled` (default on) and command *Toggle Inline Git Blame*.
- New setting `ideagittool.dialogs.openInNewWindow` (default off): dialogs and the merge window open in their own window.

## 0.2.0

- Native VS Code look by default (`ideagittool.appearance`: `vscode`); the IntelliJ look stays available as `intellij`. Layout and features are unchanged.
- IntelliJ's three-pane merge window and the iterative Conflicts dialog (Save and Close, Accept and Finish, gutter operations, magic resolve, collapse unchanged fragments).
- Local History, Create Patch dialog, Rollback File…, Remove from VCS, Revert Resolved, Copy Path/Reference….
- Git log: long edges, GPG signature column, diff preview, collapse linear branches, Not Cherry-Picked Commits, Show My Branches, multi-repository log, Drop / Extract Selected Changes, Add Commits to Remote Branch.
- Worktrees view, synchronous branch control, Update Project with Stash or Shelve, Reset to the Remote Branch, Update Force-Pushed Branch.
- Renamed to IdeaGitTool (command and setting ids `ideagittool.*`); new logo and activity bar icon.
- Simplified Chinese README.

## 0.1.0

- First version: Git log with graph, Commit tool window (changelists, shelf, stash), branches popup, push / update / pull / merge / rebase / interactive rebase / reset dialogs, conflicts, annotate and file history.
