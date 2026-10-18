# IdeaGitTool

English | [简体中文](README.zh-CN.md)

A VS Code extension that re-creates [Rebased](https://github.com/detachhead/rebased), the standalone git client built on the
IntelliJ platform. It keeps the IntelliJ git workflow, menu wording, keyboard shortcuts, icons and New UI look.

## Installation

**Requirements:** VS Code 1.90 or later, and Git 2.25 or later on your `PATH` (or set `ideagittool.gitPath`). The log actions that edit commits without touching the working tree (Drop / Extract Selected Changes, Add Commits to Remote Branch) need Git 2.40 or later, and the `--update-refs` rebase option needs Git 2.38 or later.

### From the .vsix package (recommended)

1. Download [`ideagittool-0.2.0.vsix`](https://github.com/PGshen/vs-idea-gittool/raw/master/releases/ideagittool-0.2.0.vsix) from the `releases/` folder of this repository.
2. Install it in one of these ways:
   - In VS Code, open the Extensions view (Ctrl+Shift+X / Cmd+Shift+X), click the `⋯` menu at the top, choose **Install from VSIX…** and select the file.
   - Or from a terminal:
     ```
     code --install-extension ideagittool-0.2.0.vsix
     ```
3. Reload the window if VS Code asks you to.

To update, install the newer .vsix the same way. To uninstall, find **IdeaGitTool** in the Extensions view and choose **Uninstall**.

### From source

```
git clone https://github.com/PGshen/vs-idea-gittool.git
cd vs-idea-gittool
npm install
npm run package                                  # builds ideagittool-<version>.vsix
code --install-extension ideagittool-*.vsix
```

### First steps

- Open a folder that contains a Git repository. The Git log opens in the **Git** panel at the bottom, and the **IdeaGitTool** icon appears in the activity bar (Commit / Shelf / Stash / Branches).
- The **Branches** tab (Ctrl+Shift+`) holds IntelliJ's branches popup: Update Project…, Commit…, Push…, New Branch…, and every local and remote branch and tag with its actions.
- IdeaGitTool works next to VS Code's built-in Git extension; nothing has to be disabled.
- IntelliJ shortcuts are on by default and replace some VS Code shortcuts (for example Ctrl+T). Turn off `ideagittool.intellijShortcuts` to keep the VS Code ones (see Settings).

## Features

**Git log** (in the **Git** panel at the bottom; `ideagittool.log.showInEditor` opens it in the editor, like Rebased)
- Commit graph with IntelliJ lane colors, ref labels, current-branch highlight, lazy loading.
- Filter bar: *Text or hash* (regex, match case), Branch, User, Date, Paths; Graph Options (By Commit Date / Topologically, First Parent, No Merges); View Options; Go to Hash/Branch/Tag; extra tabs (Alt+G).
- Branches pane: HEAD / Local / Remote / Tags, favorites, ahead/behind, group by directory, full branch context menu.
- Changed files of the selected commits and the commit details panel ("In N branches … Show all").
- Commit context menu: Copy Revision Number, Create Patch, Cherry-Pick, Checkout, Show Repository at Revision, Compare, Reset Current Branch to Here, Revert, Undo Commit, Edit Commit Message, Fixup, Squash Into, Drop, Squash Commits, Interactively Rebase from Here, Push All up to Here, New Branch, New Tag, Go to Child/Parent.
- File History, Show History for Selection, Annotate with Git Blame, Compare with Revision / Branch or Tag.
- Inline blame: after the caret line, "author, date, time • commit subject" in a faded italic font, with a hover that links to the log and the diff (`ideagittool.inlineBlame.enabled`, command *Toggle Inline Git Blame*).
- Long edges, GPG signature column, diff preview (side-by-side / unified), Collapse / Expand Linear Branches, Not Cherry-Picked Commits, Show My Branches.
- Multi-repository log with root colors, Group by Repository; Drop / Extract Selected Changes, Add Commits to Remote Branch.

**Commit tool window** (activity bar)
- Commit / Shelf / Stash / Branches tabs. Changelists, Unversioned Files, Merge Conflicts, checkboxes, Group By, speed search, drag & drop.
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
- **Branches** tab of the Commit tool window (Ctrl+Shift+`), laid out like IntelliJ's branches popup: search field ("Search for branches and actions", matches highlighted) with Fetch and settings (Group by Directory, Show Recent Branches, Show Tags, …); Update Project…, Commit…, Push…, the Abort / Continue actions of an ongoing merge or rebase, New Branch…, Checkout Tag or Revision…; then Recent / Local / Remote / Tags grouped by directory, with the current branch, favorites (click the star), incoming / outgoing counts and a `›` that opens the branch actions (Checkout, New Branch from, Checkout and Rebase, Compare, Show Diff with Working Tree, Rebase onto, Merge into, Pull using Rebase/Merge, Update, Push, Rename, Delete, …). Double-click checks a branch out; smart checkout when local changes are in the way.
- Dialogs: Push (Force Push, push tags, Run Git hooks), Push Rejected, Update Project, Pull, Fetch, Merge, Rebase, interactive rebase (Rebasing Commits), Reset HEAD, New Branch, Tag, Remotes, Clone, Edit Commit Message, Create Patch.
- Git menu (`IdeaGitTool: Git Menu…`) and VCS Operations Popup (Alt+`).
- Update Project cleans the working tree using Stash or Shelve; Reset to the Remote Branch and Update Force-Pushed Branch.
- Worktrees view and New Worktree dialog; synchronous branch control across several repositories.
- Every git command is shown in the *IdeaGitTool: Git Console* output channel.

## Settings

- `ideagittool.appearance`: `vscode` (the default) draws every view and dialog like native VS Code: buttons, inputs, checkboxes, lists, menus, hovers, scrollbars, fonts and colors come from your VS Code theme, and monochrome icons take the theme's icon color. `intellij` keeps the IntelliJ New UI look (IntelliJ light/dark palette and widget shapes). The layout and the features are the same in both; `scripts/layout-check.mjs` verifies that no element moves.
- `ideagittool.log.showInEditor`, `ideagittool.log.openOnStartup`, `ideagittool.commit.gpgSign`, `ideagittool.commit.skipHooks`, `ideagittool.updateMethod`, `ideagittool.push.*`, `ideagittool.annotate.*`, `ideagittool.branches.*`. Open the Settings editor and search for "ideagittool" to see all of them.
- `ideagittool.inlineBlame.enabled` (default on): show the blame of the caret line at the end of the line. It is hidden while *Annotate with Git Blame* is on.
- `ideagittool.dialogs.openInNewWindow` (default off): open dialogs and the merge window in their own window, like IntelliJ's floating dialogs, instead of an editor tab. The window closes with the dialog.
- `ideagittool.intellijShortcuts` (default on): Ctrl+T Update Project, Ctrl+Shift+K Push, Ctrl+Shift+` Branches, Alt+` VCS Operations Popup, Ctrl+Alt+N New Branch, Alt+9 Git log, Ctrl+K Commit (only while the Commit view has focus). These replace the VS Code defaults on the same keys (for example Ctrl+T *Go to Symbol in Workspace* and Ctrl+Shift+` *New Terminal*). Turn the setting off to keep the VS Code shortcuts.

## Differences from Rebased

An extension cannot draw floating popups over the VS Code workbench or add menus to the gutter, so:
- Dialogs open as editor tabs that look like IntelliJ dialogs. With `ideagittool.dialogs.openInNewWindow` they open in their own window instead (VS Code chooses its size and position, and it is not modal). The branches popup is the Branches tab of the Commit tool window, and the actions of the toolbar (Update Project, Push, branch widget) are there too instead of in the status bar.
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

### Packaging

Requires Node.js 20 or later (needed by `@vscode/vsce`) and npm.

```
npm install                 # once, installs the build tools (esbuild, TypeScript, vsce)
npm test                    # optional: unit tests before packaging
npm run package             # builds ideagittool-<version>.vsix in the repository root
```

`npm run package` merges `contrib/*.json` into `package.json`, bundles `src/` into `dist/` with minification, and runs
`vsce package`. The version in the file name comes from `"version"` in `package.json`.

To publish a new version:

1. Change `"version"` in `package.json` and add an entry to `CHANGELOG.md`.
2. Run `npm run package`.
3. Copy the result to `releases/` (the only place where `.vsix` files are committed):
   ```
   cp ideagittool-<version>.vsix releases/
   ```
4. Commit, then tag the release: `git tag -a v<version> -m "IdeaGitTool <version>"` and `git push origin v<version>`.

Install the package with `code --install-extension ideagittool-<version>.vsix` (see Installation).

See ARCHITECTURE.md for the code layout.

## License

Apache 2.0. The UI icons are from the IntelliJ Platform, see the NOTICE file; the extension logo is original.
