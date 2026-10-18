# Architecture

IdeaGitTool re-creates the git UI of [Rebased](https://github.com/detachhead/rebased)
(the IntelliJ platform git integration) as a VS Code extension.

## Layout

```
src/
  extension.ts          activation: repository manager, content provider, features
  context.ts            Ctx: services passed to every feature
  shared/types.ts       types shared by host and webviews (no imports)
  shared/mergeModel.ts  MergeModel: IntelliJ's MergeConflictModel / MergeModelBase (change states, range updates on
                        edits, apply / append / ignore / magic, acceptRevisionForSide), used by the host and the merge webview
  shared/mergeResolve.ts  MergeResolveUtil (magic resolve) and ByWord 3-way inner differences
  shared/intellijDiff.ts  Diff.buildChanges (Reindexer + MyersLCS), so line and word diffs match IntelliJ
  git/
    exec.ts             runs git, mirrors every command into the "IdeaGitTool: Git Console" output
    repository.ts       Repository: cached status / refs / remotes / stashes, file watching, onDidChange
    manager.ts          RepositoryManager: finds repositories, pick(), getForFile()
  host/
    webviewHost.ts      WebviewConnection: RPC between host and a webview bundle, theme, showError
    dialog.ts           showDialog(kind, props, opts): IntelliJ-style modal dialog in a webview panel
    gitContent.ts       ideagittool-git: read-only file system (file at revision), openChangeDiff, openMultiDiff
    ui.ts               withProgress, notifySuccess/Warning/Error, ask, confirmDialog, input
    output.ts           Git console output channel
  features/
    index.ts            FEATURES list: each feature is (ctx: Ctx) => void
    localHistory/       Local History: recorder (file watcher, saves), store (events + blobs), Local History window
    log/                Git log editor tab / panel view, file history, annotate, compare
    commit/             Commit tool window (changes, changelists, commit, amend, shelf, stash; other features add tabs through ctx.commitView), conflicts, merge window (mergeTool.ts + webview/merge), rollback
    ops/                Branches tab (branchesTab.ts + branchActions.ts), push/update/pull/fetch/merge/rebase/reset/tag/remotes/clone dialogs,
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
  `vscode.commands.executeCommand('ideagittool.cherryPick', { root, hashes })`. When `root` is missing the
  command picks a repository with `ctx.repos.pick()`.
- Use `repo.batch(fn)` for multi-step operations, then the UI refreshes once.
- UI text follows IntelliJ's GitBundle / VcsBundle wording exactly.
- Icons: `<Icon name="vcs/push" />`. Mappings from AllIcons names are in media/icons/PlatformIconMappings.json.
- Merge: the Conflicts dialog (features/commit/conflicts.ts) keeps one MergeModel per file for the dialog session
  (MergeConflictIterativeDataHolder). The merge window (mergeTool.ts + webview/merge) gets the model state as
  `progress` and returns the result lines and change states on Save and Close / Apply / Accept; the dialog writes
  the work tree file and stages only on Accept and Finish / Close. The webview drives CodeMirror with the model's
  line edits; user edits update change ranges with `updateRangeOnModification` (engine.ts `modelExtension`).
- Visual check: `node scripts/preview.mjs <bundle> test/fixtures/<x>.mjs out.png [--light]` renders a bundle with a mocked host.

## Command ownership

Commands other features may call (argument object in braces):

| Feature | Commands |
|-|-|
| log | `ideagittool.showLog {root?, branch?, path?}`, `ideagittool.log.selectCommit {root, hash}`, `ideagittool.showFileHistory (uri \| {root, path})`, `ideagittool.showHistoryForSelection`, `ideagittool.annotate (uri)`, `ideagittool.compareWithRevision (uri)`, `ideagittool.compareWithBranch (uri)`, `ideagittool.compareRefs {root, ref, with?}` (commits + files between two refs), `ideagittool.showCommitDiff {root, hash, path?}`, `ideagittool.showRepositoryAtRevision {root, hash}` |
| commit | `ideagittool.commit`, `ideagittool.commitAndPush`, `ideagittool.resolveConflicts {root?}`, `ideagittool.stash {root?}`, `ideagittool.unstash {root?}`, `ideagittool.shelve`, `ideagittool.unshelve`, `ideagittool.rollback (uri?)`, `ideagittool.addToVcs (uri)`, `ideagittool.addToGitignore (uri)`, `ideagittool.showLocalDiff (uri)`, `ideagittool.refreshChanges` |
| commit (more) | `ideagittool.shelveSilently {root, name}` (shelves all local changes, returns the shelf id), `ideagittool.unshelveSilently {id}` (returns `{ok, conflicts}`), `ideagittool.createPatchFromChanges {keys? \| changes? \| root+hashes}` (Create Patch dialog), `ideagittool.rollbackFile (uri)`, `ideagittool.removeFromVcs (uri)`, `ideagittool.revertResolved (uri?)`, `ideagittool.copyPath {kind}` |
| localHistory | `ideagittool.localHistory.showHistory (uri?)`, `.showSelectionHistory`, `.showProjectHistory`, `.recentChanges`, `.putLabel`, `ideagittool.localHistory.putSystemLabel {root?, label}` (labels such as "Before Update" around git operations) |
| ops | `ideagittool.updateForcePushedBranch {root?}`, `ideagittool.resetToRemoteBranch {root?}`, `ideagittool.worktrees.<action>` (create {root?, ref?}, show, refresh, open {root, path?, branch?}, delete, prune, lock, unlock), `ideagittool.branches` (reveals the Branches tab), `ideagittool.checkoutTagOrRevision {root?}`, `ideagittool.mainMenu`, `ideagittool.updateProject {root?}`, `ideagittool.pull {root?}`, `ideagittool.fetch {root?}`, `ideagittool.push {root?, upTo?}`, `ideagittool.merge {root?}`, `ideagittool.rebase {root?}`, `ideagittool.resetHead {root?, hash?}`, `ideagittool.createBranch {root?, startPoint?}`, `ideagittool.createTag {root?, hash?}`, `ideagittool.checkoutRevision {root, hash}`, `ideagittool.cherryPick {root, hashes}`, `ideagittool.revertCommits {root, hashes}`, `ideagittool.undoCommit {root, hash}`, `ideagittool.rewordCommit {root, hash}`, `ideagittool.fixupCommit {root, hash, squash?}`, `ideagittool.squashCommits {root, hashes}`, `ideagittool.dropCommits {root, hashes}`, `ideagittool.interactiveRebase {root, hash}`, `ideagittool.createPatch {root, hashes?, changes?}`, `ideagittool.applyPatch`, `ideagittool.abortOperation {root?}`, `ideagittool.continueOperation {root?}`, `ideagittool.skipCommit {root?}`, `ideagittool.remotes {root?}`, `ideagittool.clone`, `ideagittool.init`, `ideagittool.unshallow {root?}`, `ideagittool.branch.<action> {root, name, type}` where action is checkout, newBranchFrom, checkoutAndRebase, compare, showDiffWithWorkingTree, rebaseCurrentOnto, mergeIntoCurrent, pullRebase, pullMerge, push, update, rename, delete, toggleFavorite, trackRemote; `ideagittool.tag.<action> {root, name}` (checkout, mergeIntoCurrent, push, delete) |

Contracts used by ops and implemented by other features (ops falls back gracefully when they are missing):
`ideagittool.shelveSilently {root, name}` → shelf id, `ideagittool.unshelveSilently {id}` → `{ok, conflicts}` (commit; "Clean working tree using Shelve"),
`ideagittool.localHistory.putSystemLabel {root, label}` (Local History labels such as "Before Update"), `ideagittool.showShelf`, `ideagittool.showStashes`.
