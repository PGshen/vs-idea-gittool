# Generates contrib/30-ops.json (commands, palette visibility, keybindings, settings of the ops feature).
import json

cmds = [
    ("ideagittool.push", "Push…"), ("ideagittool.fetch", "Fetch"), ("ideagittool.pull", "Pull…"),
    ("ideagittool.updateProject", "Update Project…"), ("ideagittool.remotes", "Manage Remotes…"),
    ("ideagittool.clone", "Clone…"), ("ideagittool.init", "Create Git Repository…"), ("ideagittool.unshallow", "Unshallow repository"),
    ("ideagittool.branches", "Branches…"), ("ideagittool.createBranch", "New Branch…"),
    ("ideagittool.merge", "Merge…"), ("ideagittool.rebase", "Rebase…"), ("ideagittool.resetHead", "Reset HEAD…"),
    ("ideagittool.createTag", "New Tag…"), ("ideagittool.createPatch", "Create Patch from Local Changes…"),
    ("ideagittool.applyPatch", "Apply Patch…"), ("ideagittool.applyPatchFromClipboard", "Apply Patch from Clipboard…"),
    ("ideagittool.abortOperation", "Abort Merge / Rebase / Cherry-Pick / Revert"),
    ("ideagittool.continueOperation", "Continue Rebase / Cherry-Pick / Commit Merge"),
    ("ideagittool.skipCommit", "Skip Commit"), ("ideagittool.mainMenu", "Git Menu…"),
    ("ideagittool.vcsOperationsPopup", "VCS Operations Popup…"), ("ideagittool.currentFileMenu", "Git: Current File…"),
    ("ideagittool.copyBranchName", "Copy Current Branch Name"),
    ("ideagittool.updateForcePushedBranch", "Update Force-Pushed Branch"),
    ("ideagittool.resetToRemoteBranch", "Reset to the Remote Branch"),
    ("ideagittool.worktrees.create", "New Worktree…"), ("ideagittool.worktrees.show", "Worktrees…"),
    ("ideagittool.worktrees.refresh", "Refresh Worktrees"), ("ideagittool.worktrees.prune", "Prune Worktrees"),
    ("ideagittool.worktrees.open", "Open Worktree…"), ("ideagittool.worktrees.delete", "Delete Worktree…"),
    ("ideagittool.worktrees.lock", "Lock Worktree"), ("ideagittool.worktrees.unlock", "Unlock Worktree"),
]
hidden = ["ideagittool.branch." + a for a in "checkout newBranchFrom checkoutAndRebase checkoutAndUpdate compare showDiffWithWorkingTree rebaseCurrentOnto mergeIntoCurrent pullRebase pullMerge push update rename delete toggleFavorite trackRemote".split()]
hidden += ["ideagittool.tag." + a for a in "checkout mergeIntoCurrent push delete".split()]
hidden += ["ideagittool.cherryPick", "ideagittool.revertCommits", "ideagittool.undoCommit", "ideagittool.rewordCommit", "ideagittool.fixupCommit", "ideagittool.squashCommits",
           "ideagittool.dropCommits", "ideagittool.interactiveRebase", "ideagittool.checkoutRevision", "ideagittool.ops.pickToolbarRepository"]
titles = {
    "ideagittool.cherryPick": "Cherry-Pick", "ideagittool.revertCommits": "Revert Commit", "ideagittool.undoCommit": "Undo Commit…",
    "ideagittool.rewordCommit": "Edit Commit Message…", "ideagittool.fixupCommit": "Fixup…", "ideagittool.squashCommits": "Squash Commits…",
    "ideagittool.dropCommits": "Drop Commits", "ideagittool.interactiveRebase": "Interactively Rebase from Here…",
    "ideagittool.checkoutRevision": "Checkout Revision", "ideagittool.ops.pickToolbarRepository": "Select Toolbar Repository",
}
def icon(name):
    return {"light": f"media/icons/{name}.svg", "dark": f"media/icons/{name}_dark.svg"}

icons = {
    "ideagittool.worktrees.create": "general/add", "ideagittool.worktrees.refresh": "general/refresh",
    "ideagittool.worktrees.delete": "general/delete", "ideagittool.worktrees.prune": "actions/clearCash",
    "ideagittool.worktrees.open": "general/open",
}
commands = [{"command": c, "title": t, "category": "IdeaGitTool", **({"icon": icon(icons[c])} if c in icons else {})} for c, t in cmds]
commands += [{"command": c, "title": titles.get(c, c.split('.', 1)[1]), "category": "IdeaGitTool"} for c in hidden]
palette = [{"command": c, "when": "false"} for c in hidden]
for c in ["ideagittool.push", "ideagittool.fetch", "ideagittool.pull", "ideagittool.updateProject", "ideagittool.branches", "ideagittool.createBranch", "ideagittool.merge",
          "ideagittool.rebase", "ideagittool.resetHead", "ideagittool.createTag", "ideagittool.remotes", "ideagittool.unshallow", "ideagittool.copyBranchName",
          "ideagittool.createPatch", "ideagittool.applyPatch", "ideagittool.applyPatchFromClipboard",
          "ideagittool.updateForcePushedBranch", "ideagittool.resetToRemoteBranch", "ideagittool.worktrees.create", "ideagittool.worktrees.show",
          "ideagittool.worktrees.refresh", "ideagittool.worktrees.prune", "ideagittool.worktrees.open", "ideagittool.worktrees.delete",
          "ideagittool.worktrees.lock", "ideagittool.worktrees.unlock"]:
    palette.append({"command": c, "when": "ideagittool.hasRepository"})
for c in ["ideagittool.abortOperation", "ideagittool.continueOperation", "ideagittool.skipCommit"]:
    palette.append({"command": c, "when": "ideagittool.operation && ideagittool.operation != 'none'"})

when = "config.ideagittool.intellijShortcuts"
keys = [
    {"command": "ideagittool.push", "key": "ctrl+shift+k", "mac": "cmd+shift+k", "when": when + " && !editorTextFocus"},
    {"command": "ideagittool.push", "key": "ctrl+shift+k", "mac": "cmd+shift+k", "when": when + " && editorTextFocus && config.ideagittool.intellijShortcutsInEditor"},
    {"command": "ideagittool.updateProject", "key": "ctrl+t", "mac": "cmd+t", "when": when},
    {"command": "ideagittool.branches", "key": "ctrl+shift+`", "mac": "cmd+shift+`", "when": when},
    {"command": "ideagittool.vcsOperationsPopup", "key": "alt+`", "mac": "ctrl+v", "when": when + " && !terminalFocus && !editorTextFocus"},
    {"command": "ideagittool.createBranch", "key": "ctrl+alt+n", "mac": "alt+cmd+n", "when": when + " && ideagittool.hasRepository"},
]
config = {"title": "IdeaGitTool", "properties": {
    "ideagittool.intellijShortcuts": {"type": "boolean", "default": True, "description": "Use IntelliJ keyboard shortcuts for Git actions (Ctrl+T Update Project, Ctrl+Shift+K Push, Ctrl+Shift+` Branches, Alt+` VCS Operations Popup, Ctrl+Alt+N New Branch)."},
    "ideagittool.intellijShortcutsInEditor": {"type": "boolean", "default": False, "description": "Also use Ctrl+Shift+K for Push while a text editor has focus (it replaces VS Code's Delete Line)."},
    "ideagittool.updateMethod": {"type": "string", "enum": ["merge", "rebase", "branchDefault"], "enumDescriptions": ["Merge incoming changes into the current branch", "Rebase the current branch on top of incoming changes", "Branch Default (git config branch.<name>.rebase / pull.rebase)"], "default": "merge", "description": "Update method used by Update Project."},
    "ideagittool.update.showDialog": {"type": "boolean", "default": True, "description": "Show the Update Project dialog before updating."},
    "ideagittool.update.saveChangesPolicy": {"type": "string", "enum": ["stash", "shelve"], "default": "stash", "enumDescriptions": ["Using Stash", "Using Shelve"], "description": "Clean working tree using: Stash / Shelve. Local changes are saved before Update Project, Smart Checkout and Smart Merge, and restored afterwards."},
    "ideagittool.push.tags": {"type": "string", "enum": ["none", "all", "current"], "default": "none", "description": "Push tags option of the Push dialog."},
    "ideagittool.push.runHooks": {"type": "boolean", "default": True, "description": "Run Git hooks on push."},
    "ideagittool.push.autoUpdateOnRejected": {"type": "string", "enum": ["", "merge", "rebase"], "default": "", "description": "Update method to use silently when a push is rejected. Empty: ask with the Push Rejected dialog."},
    "ideagittool.fetch.prune": {"type": "boolean", "default": False, "description": "Prune obsolete remote references on fetch."},
    "ideagittool.branches.showRecent": {"type": "boolean", "default": True, "description": "Show recent branches in the branches popup."},
    "ideagittool.branches.showTags": {"type": "boolean", "default": True, "description": "Show tags in the branches popup."},
    "ideagittool.branches.syncControl": {"type": "boolean", "default": True, "description": "Execute branch operations on all roots: with several repositories, branches that exist in all of them are shown once in the branches popup and their actions run in every repository."},
    "ideagittool.statusBar.enabled": {"type": "boolean", "default": True, "description": "Show the Git toolbar widgets (Update Project, Push, branch, merge/rebase actions) in the status bar."},
}}
wt = "view == ideagittool.worktrees"
menus = {
    "commandPalette": palette,
    "view/title": [
        {"command": "ideagittool.worktrees.create", "when": wt, "group": "navigation@1"},
        {"command": "ideagittool.worktrees.refresh", "when": wt, "group": "navigation@2"},
        {"command": "ideagittool.worktrees.delete", "when": wt, "group": "navigation@3"},
        {"command": "ideagittool.worktrees.prune", "when": wt, "group": "navigation@4"},
    ],
    "view/item/context": [
        {"command": "ideagittool.worktrees.open", "when": wt + " && viewItem =~ /^worktree/", "group": "1_open@1"},
        {"command": "ideagittool.worktrees.lock", "when": wt + " && viewItem =~ / linked / && viewItem =~ / unlocked/", "group": "1_open@2"},
        {"command": "ideagittool.worktrees.unlock", "when": wt + " && viewItem =~ / locked/", "group": "1_open@2"},
        {"command": "ideagittool.worktrees.delete", "when": wt + " && viewItem =~ / linked /", "group": "2_delete@1"},
    ],
}
views = {"ideagittool-panel": [{"id": "ideagittool.worktrees", "name": "Worktrees", "when": "ideagittool.hasRepository"}]}
welcome = [{"view": "ideagittool.worktrees", "contents": "No linked worktrees\n[Create worktree…](command:ideagittool.worktrees.create)\n[What is a Git worktree](https://git-scm.com/docs/git-worktree)"}]
out = {"commands": commands, "menus": menus, "keybindings": keys, "configuration": config, "views": views, "viewsWelcome": welcome}
with open('contrib/30-ops.json', 'w') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write('\n')
