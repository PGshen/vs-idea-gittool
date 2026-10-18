# Changelog

## Unreleased

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
