# IdeaGitTool

A VS Code extension that re-creates [Rebased](https://github.com/detachhead/rebased), the standalone git client built on the
IntelliJ platform. It keeps the IntelliJ git workflow, menu wording, keyboard shortcuts, icons and New UI look.

## Features

**Git log** (opens in the editor, like Rebased; `ideagittool.log.showInEditor` moves it to the bottom panel)
- Commit graph with IntelliJ lane colors, ref labels, current-branch highlight, lazy loading.
- Filter bar: *Text or hash* (regex, match case), Branch, User, Date, Paths; Graph Options (By Commit Date / Topologically, First Parent, No Merges); View Options; Go to Hash/Branch/Tag; extra tabs (Alt+G).
- Branches pane: HEAD / Local / Remote / Tags, favorites, ahead/behind, group by directory, full branch context menu.
- Changed files of the selected commits and the commit details panel ("In N branches … Show all").
- Commit context menu: Copy Revision Number, Create Patch, Cherry-Pick, Checkout, Show Repository at Revision, Compare, Reset Current Branch to Here, Revert, Undo Commit, Edit Commit Message, Fixup, Squash Into, Drop, Squash Commits, Interactively Rebase from Here, Push All up to Here, New Branch, New Tag, Go to Child/Parent.
- File History, Show History for Selection, Annotate with Git Blame, Compare with Revision / Branch or Tag.
- Long edges, GPG signature column, diff preview (side-by-side / unified), Collapse / Expand Linear Branches, Not Cherry-Picked Commits, Show My Branches.
- Multi-repository log with root colors, Group by Repository; Drop / Extract Selected Changes, Add Commits to Remote Branch.

**Commit tool window** (activity bar)
- Commit / Shelf / Stash tabs. Changelists, Unversioned Files, Merge Conflicts, checkboxes, Group By, speed search, drag & drop.
- Amend (also of older commits), commit message history, Commit / Commit and Push…, commit options (Author, Sign-off, extra commit for file movements). Commits exactly the checked files, without the staging area.
- Shelve / Unshelve (untracked files included), Stash / Unstash dialogs, Rollback, Add to VCS, Add to .gitignore.
- Conflicts dialog in IntelliJ's iterative mode (Rebased default): Unresolved / Resolved groups with `resolved/total` badges, inline Accept buttons, Accept ‘Yours’ / ‘Theirs’ and Revert Conflict Resolution in the context menu, Resolve All Simple Conflicts with its status, Group by directory, Close / Accept and Finish / Resolve Manually (Review Changes). Partially merged files are saved by the merge window's *Save and Close* and continue where they were left when reopened; files are marked resolved in git by *Accept and Finish*.
- IntelliJ's three-pane merge window: Yours on the left (mirrored, gutter next to the divider), the editable Result in the middle, Theirs on the right, with curved connectors (dotted once resolved), synchronized scrolling, word highlighting, the »/«/×/magic operations in the gutter next to the line numbers (Ctrl+click resolves the whole conflict, append for the second side), manual edits tracked like IntelliJ (change ranges follow typing, edited changes are no longer auto-resolvable), magic resolve ported from MergeResolveUtil, the editor context menus (Accept / Resolve using / Resolve Automatically / Ignore, Compare with Clipboard, Collapse Unchanged Fragments, Synchronize Scrolling), Collapse Unchanged Fragments (`ideagittool.merge.contextLines`), Apply Non-Conflicting Changes (Left / All / Right), Resolve Simple Conflicts, Revert Conflict Resolution, Compare Contents, F7 / Shift+F7, undo, Accept Left / Accept Right / Save and Close / Apply Changes. CRLF and the final newline are kept. Binary and deleted/modified conflicts get a simple Accept Left / Accept Right choice. Set `ideagittool.merge.useVsCodeMergeEditor` to use VS Code's merge editor instead.
- IntelliJ file status colors in the Explorer and editor tabs.
- Rollback File…, Remove from VCS, Revert Resolved, Copy Path/Reference…, Create Patch dialog.

**Local History**
- Snapshots on save, create, delete, rename and external changes (git operations), labels such as "Before Update".
- Show History, Show History for Selection, Show Project History, Recent Changes (Alt+Shift+C), Put Label…, revert and create patch.

**Toolbar and operations**
- Status bar in Rebased order: Update Project ↙, Push ↗, branch widget (↓↑ counts), merge/rebase widget with Continue / Abort.
- Branches popup (Ctrl+Shift+`) with Recent / Local / Remote / Tags and the per-branch actions (Checkout, New Branch from, Checkout and Rebase, Compare, Show Diff with Working Tree, Rebase onto, Merge into, Pull using Rebase/Merge, Update, Push, Rename, Delete, …), smart checkout.
- Dialogs: Push (Force Push, push tags, Run Git hooks), Push Rejected, Update Project, Pull, Fetch, Merge, Rebase, interactive rebase (Rebasing Commits), Reset HEAD, New Branch, Tag, Remotes, Clone, Edit Commit Message, Create Patch.
- Git menu (`IdeaGitTool: Git Menu…`) and VCS Operations Popup (Alt+`).
- Update Project cleans the working tree using Stash or Shelve; Reset to the Remote Branch and Update Force-Pushed Branch.
- Worktrees view and New Worktree dialog; synchronous branch control across several repositories.
- Every git command is shown in the *IdeaGitTool: Git Console* output channel.

## Settings

- `ideagittool.appearance`: `vscode` (the default) draws every view and dialog like native VS Code: buttons, inputs, checkboxes, lists, menus, hovers, scrollbars, fonts and colors come from your VS Code theme, and monochrome icons take the theme's icon color. `intellij` keeps the IntelliJ New UI look (IntelliJ light/dark palette and widget shapes). The layout and the features are the same in both; `scripts/layout-check.mjs` verifies that no element moves.
- `ideagittool.log.showInEditor`, `ideagittool.log.openOnStartup`, `ideagittool.commit.gpgSign`, `ideagittool.commit.skipHooks`, `ideagittool.updateMethod`, `ideagittool.push.*`, `ideagittool.annotate.*`, `ideagittool.statusBar.enabled`. Open the Settings editor and search for "ideagittool" to see all of them.
- `ideagittool.intellijShortcuts` (default on): Ctrl+T Update Project, Ctrl+Shift+K Push, Ctrl+Shift+` Branches, Alt+` VCS Operations Popup, Ctrl+Alt+N New Branch, Alt+9 Git log, Ctrl+K Commit (only while the Commit view has focus). These replace the VS Code defaults on the same keys (for example Ctrl+T *Go to Symbol in Workspace* and Ctrl+Shift+` *New Terminal*). Turn the setting off to keep the VS Code shortcuts.

## Differences from Rebased

VS Code has no floating windows or gutter menus, so:
- Dialogs open as editor tabs that look like IntelliJ dialogs; popups such as the branches popup are VS Code quick picks.
- Diffs use the VS Code diff editor; merges use an IntelliJ-style three-pane merge window built on CodeMirror.
- Annotation options live in the hover and the line-number context menu.

Other limitations:
- In a workspace with several repositories, file history and branch comparison show one repository (as in IntelliJ), and the combined log orders commits by date.
- With synchronous branch control, branch submenu labels use the first repository's current branch name.
- *Linearize Merges* is not offered (IntelliJ shows it only behind an internal registry flag).
- Opening a worktree always uses a new window.

## Development

```
npm install
npm run build        # merges contrib/*.json into package.json and bundles dist/
npm test             # node:test, incl. real git operations on temporary repositories
npm run typecheck
npm run package      # builds ideagittool-<version>.vsix
node scripts/preview.mjs <bundle> test/fixtures/<x>.mjs out.png [--light | --vscode=dark|light]   # render a webview with a mocked host
node scripts/layout-check.mjs [--base=<ref>]                                # element boxes must not move against <ref>
sh scripts/preview-vscode.sh <dir> dark|light                              # screenshots of the main views in the VS Code look
xvfb-run -a node scripts/e2e.mjs test/e2e-log.mjs                          # run a scenario in real VS Code
```

See ARCHITECTURE.md for the code layout.

## License

Apache 2.0. The UI icons are from the IntelliJ Platform, see the NOTICE file; the extension logo is original.
