# Changelog

## Unreleased

- Git log: it no longer opens automatically when a workspace with a Git repository is opened, so it does not replace the Terminal panel. Use *Show Git Log*, or turn on `ideagittool.log.openOnStartup` to get the previous behavior.
- Shortcuts: hint texts follow the platform — menus and tooltips show IntelliJ's macOS glyphs (⌘D, ⌥⌘A, ⇧⌘K) instead of Windows-style Ctrl+…, in the Commit / Shelf / Stash / Branches / Git log / Merge / Local History views, their dialogs and the VCS operations popup. The VCS Operations Popup shows ⌃V on macOS, its actual binding there. The merge window's ⌘⌥↓/↑/R/A (navigate conflicts, Accept Left/Right) now fire on macOS — the physical ⌃⌥ forms keep working. Delete menu items show ⌫ on macOS, and plain ⌫ (Backspace) also deletes the selected files, shelves, stashes and branches, like IntelliJ; the trees' speed search takes ⌫ first, so fixing a typo in a query never deletes anything. Set Active Changelist shows ⌃Space. Hints for shortcuts that were not actually bound anywhere were removed instead of advertising dead keys (Ctrl+Alt+P Group by Directory, Ctrl+Shift+C / Ctrl+Alt+Shift+C copy path / reference, Ctrl+= / Ctrl+- expand / collapse all, Alt+Shift+A Show All Affected Files).
- Commit tool window: *Generate Commit Message with AI* — the sparkle button next to the commit message history sends the diff of the checked files to the configured AI provider and streams the generated message into the box, like IntelliJ's AI Assistant. Providers: OpenAI-compatible endpoints (OpenAI, DeepSeek, Kimi, Qwen, Ollama, LM Studio, internal gateways) and the Anthropic Messages API (`ideagittool.ai.provider` / `baseUrl` / `model`); only the checked files are sent, the diff per repository is capped at `ideagittool.ai.maxDiffChars`; recent commit messages give the repository's style; `ideagittool.ai.language` sets the language and `ideagittool.ai.prompt` replaces the built-in instructions. API keys are stored in SecretStorage (command *Set API Key for AI Commit Messages…*) and are optional. Cancelling the progress notification or a failure restores the previous message; while generating the box is read-only and Commit is blocked.

## 0.4.3

- New setting `ideagittool.language` (`system` / `en` / `zh-cn`): choose the language of IdeaGitTool's views, dialogs and notifications independently of VS Code's display language. Reload the window after changing it. Labels contributed to VS Code's menus and Settings editor still follow the display language.
- Merge window: Cut, Copy and Paste work through the keyboard and the editor context menu, also in pop-out windows. The read-only side panes can be focused and support selecting and copying text.
- Shortcuts: Option+letter shortcuts on macOS now fire (Option+M Amend, Cmd+Option+K/Z/A/U, Option+G). Ctrl+K in the Commit view's changes tree focuses the commit message, and Ctrl+Alt+K no longer risks committing twice. `ideagittool.intellijShortcutsInEditor` also binds Ctrl+K to Commit everywhere; with it on, Ctrl+K no longer starts VS Code's Ctrl+K chords.
- Git log branches pane with several repositories and *Group by Repository* off: branches with the same name are merged into one row that lists its repositories, like IntelliJ (`dev (gvideo-hub, gvideo-task, console)`). Its actions (Checkout, Update, Push, Rebase, Merge, Compare, Delete, New Branch from…, favorites) run in each of those repositories. Branch names in the pane are no longer cut to make room for the hint.
- Git log branches pane: *Group by Directory* and *Group by Repository* exclude each other; turning one on turns the other off.
- Multi-root Git log: consecutive commits of one repository share a single continuous root color strip, like IntelliJ.

## 0.4.2

- Simplified Chinese UI: commands, settings, notifications, dialogs and all tool windows follow the VS Code display language (*Configure Display Language*), with IntelliJ's Chinese wording. English stays the default.
- Commit tool window: *Show Git Log* and *Show Git Console* buttons in the title bar.
- Git log: once a file's diff is open from the changes tree, a single click (or the arrow keys) on another file shows it in the same diff editor, like IntelliJ's diff preview tab.
- Git log: the "doesn't match the filters" warning names the branch (or a short hash) instead of the full hash.
- Text in the tool windows is no longer thinned on macOS (no `-webkit-font-smoothing: antialiased`), which made it look blurry on 1x screens.
- "vscode" appearance: the commit graph uses IntelliJ's light-theme brightness in light themes.

## 0.4.1

- Jump to Source from Diff via the editor context menu or F4, including native multi-file diff editors. Context-menu navigation uses the clicked file even when no text editor is active, and renamed files open their current working path.

## 0.4.0

- Popup menus (branch actions, context menus) stand out in themes whose menu colors match the sidebar, such as Tokyo Night Storm: a contrasting border, a theme-independent shadow, a slightly lifted background and a stronger highlighted item.
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
