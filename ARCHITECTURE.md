# Architecture

Rebased for VS Code re-creates the git UI of [Rebased](https://github.com/detachhead/rebased)
(the IntelliJ platform git integration) as a VS Code extension.

## Layout

```
src/
  extension.ts          activation: repository manager, content provider, features
  context.ts            Ctx: services passed to every feature
  shared/types.ts       types shared by host and webviews (no imports)
  git/
    exec.ts             runs git, mirrors every command into the "Rebased: Git Console" output
    repository.ts       Repository: cached status / refs / remotes / stashes, file watching, onDidChange
    manager.ts          RepositoryManager: finds repositories, pick(), getForFile()
  host/
    webviewHost.ts      WebviewConnection: RPC between host and a webview bundle, theme, showError
    dialog.ts           showDialog(kind, props, opts): IntelliJ-style modal dialog in a webview panel
    gitContent.ts       rebased-git: read-only file system (file at revision), openChangeDiff, openMultiDiff
    ui.ts               withProgress, notifySuccess/Warning/Error, ask, confirmDialog, input
    output.ts           Git console output channel
  features/
    index.ts            FEATURES list: each feature is (ctx: Ctx) => void
    localHistory/       Local History: recorder (file watcher, saves), store (events + blobs), Local History window
    log/                Git log editor tab / panel view, file history, annotate, compare
    commit/             Commit tool window (changes, changelists, commit, amend, shelf, stash), conflicts, merge window (mergeTool.ts + webview/merge), rollback
    ops/                Branches popup, status bar widgets, push/update/pull/fetch/merge/rebase/reset/tag/remotes/clone dialogs,
                        interactive rebase, commit editing in log, cherry-pick/revert, ongoing operation actions, Git main menu
  webview/
    lib/                shared webview code: rpc, icons, components (Toolbar, Tree, Split, ...), menu (popups), base.css
    <bundle>/main.tsx   one bundle per directory, built to dist/webview/<bundle>.js/.css
    dialog/dialogs/*    one file per dialog kind, registered with registerDialog(kind, Component)
contrib/*.json          package.json "contributes" fragments, merged by `npm run contrib` (arrays concatenated)
media/icons/            IntelliJ New UI (expui) icons, Apache 2.0. `<dir>/<name>.svg` and `<name>_dark.svg`
```

## Conventions

- Webviews talk to the host only through `call(method, params)` / `on(event)` (src/webview/lib/rpc.ts).
  Hosts register handlers with `WebviewConnection.handle()`. Errors thrown by a handler are shown as a notification.
- Command arguments are plain JSON objects so that webviews, menus and other features can call them:
  `vscode.commands.executeCommand('rebased.cherryPick', { root, hashes })`. When `root` is missing the
  command picks a repository with `ctx.repos.pick()`.
- Use `repo.batch(fn)` for multi-step operations, then the UI refreshes once.
- UI text follows IntelliJ's GitBundle / VcsBundle wording exactly.
- Icons: `<Icon name="vcs/push" />`. Mappings from AllIcons names are in media/icons/PlatformIconMappings.json.
- Visual check: `node scripts/preview.mjs <bundle> test/fixtures/<x>.mjs out.png [--light]` renders a bundle with a mocked host.

## Command ownership

Commands other features may call (argument object in braces):

| Feature | Commands |
|-|-|
| log | `rebased.showLog {root?, branch?, path?}`, `rebased.log.selectCommit {root, hash}`, `rebased.showFileHistory (uri \| {root, path})`, `rebased.showHistoryForSelection`, `rebased.annotate (uri)`, `rebased.compareWithRevision (uri)`, `rebased.compareWithBranch (uri)`, `rebased.compareRefs {root, ref, with?}` (commits + files between two refs), `rebased.showCommitDiff {root, hash, path?}`, `rebased.showRepositoryAtRevision {root, hash}` |
| commit | `rebased.commit`, `rebased.commitAndPush`, `rebased.resolveConflicts {root?}`, `rebased.stash {root?}`, `rebased.unstash {root?}`, `rebased.shelve`, `rebased.unshelve`, `rebased.rollback (uri?)`, `rebased.addToVcs (uri)`, `rebased.addToGitignore (uri)`, `rebased.showLocalDiff (uri)`, `rebased.refreshChanges` |
| commit (more) | `rebased.shelveSilently {root, name}` (shelves all local changes, returns the shelf id), `rebased.unshelveSilently {id}` (returns `{ok, conflicts}`), `rebased.createPatchFromChanges {keys? \| changes? \| root+hashes}` (Create Patch dialog), `rebased.rollbackFile (uri)`, `rebased.removeFromVcs (uri)`, `rebased.revertResolved (uri?)`, `rebased.copyPath {kind}` |
| localHistory | `rebased.localHistory.showHistory (uri?)`, `.showSelectionHistory`, `.showProjectHistory`, `.recentChanges`, `.putLabel`, `rebased.localHistory.putSystemLabel {root?, label}` (labels such as "Before Update" around git operations) |
| ops | `rebased.updateForcePushedBranch {root?}`, `rebased.resetToRemoteBranch {root?}`, `rebased.worktrees.<action>` (create {root?, ref?}, show, refresh, open {root, path?, branch?}, delete, prune, lock, unlock), `rebased.branches {root?, single?}`, `rebased.mainMenu`, `rebased.updateProject {root?}`, `rebased.pull {root?}`, `rebased.fetch {root?}`, `rebased.push {root?, upTo?}`, `rebased.merge {root?}`, `rebased.rebase {root?}`, `rebased.resetHead {root?, hash?}`, `rebased.createBranch {root?, startPoint?}`, `rebased.createTag {root?, hash?}`, `rebased.checkoutRevision {root, hash}`, `rebased.cherryPick {root, hashes}`, `rebased.revertCommits {root, hashes}`, `rebased.undoCommit {root, hash}`, `rebased.rewordCommit {root, hash}`, `rebased.fixupCommit {root, hash, squash?}`, `rebased.squashCommits {root, hashes}`, `rebased.dropCommits {root, hashes}`, `rebased.interactiveRebase {root, hash}`, `rebased.createPatch {root, hashes?, changes?}`, `rebased.applyPatch`, `rebased.abortOperation {root?}`, `rebased.continueOperation {root?}`, `rebased.skipCommit {root?}`, `rebased.remotes {root?}`, `rebased.clone`, `rebased.init`, `rebased.unshallow {root?}`, `rebased.branch.<action> {root, name, type}` where action is checkout, newBranchFrom, checkoutAndRebase, compare, showDiffWithWorkingTree, rebaseCurrentOnto, mergeIntoCurrent, pullRebase, pullMerge, push, update, rename, delete, toggleFavorite, trackRemote; `rebased.tag.<action> {root, name}` (checkout, mergeIntoCurrent, push, delete) |

Contracts used by ops and implemented by other features (ops falls back gracefully when they are missing):
`rebased.shelveSilently {root, name}` → shelf id, `rebased.unshelveSilently {id}` → `{ok, conflicts}` (commit; "Clean working tree using Shelve"),
`rebased.localHistory.putSystemLabel {root, label}` (Local History labels such as "Before Update"), `rebased.showShelf`, `rebased.showStashes`.
