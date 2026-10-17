# Generates contrib/30-ops.json (commands, palette visibility, keybindings, settings of the ops feature).
import json

cmds = [
    ("rebased.push", "Push…"), ("rebased.fetch", "Fetch"), ("rebased.pull", "Pull…"),
    ("rebased.updateProject", "Update Project…"), ("rebased.remotes", "Manage Remotes…"),
    ("rebased.clone", "Clone…"), ("rebased.init", "Create Git Repository…"), ("rebased.unshallow", "Unshallow repository"),
    ("rebased.branches", "Branches…"), ("rebased.createBranch", "New Branch…"),
    ("rebased.merge", "Merge…"), ("rebased.rebase", "Rebase…"), ("rebased.resetHead", "Reset HEAD…"),
    ("rebased.createTag", "New Tag…"), ("rebased.createPatch", "Create Patch from Local Changes…"),
    ("rebased.applyPatch", "Apply Patch…"), ("rebased.applyPatchFromClipboard", "Apply Patch from Clipboard…"),
    ("rebased.abortOperation", "Abort Merge / Rebase / Cherry-Pick / Revert"),
    ("rebased.continueOperation", "Continue Rebase / Cherry-Pick / Commit Merge"),
    ("rebased.skipCommit", "Skip Commit"), ("rebased.mainMenu", "Git Menu…"),
    ("rebased.vcsOperationsPopup", "VCS Operations Popup…"), ("rebased.currentFileMenu", "Git: Current File…"),
    ("rebased.copyBranchName", "Copy Current Branch Name"),
    ("rebased.updateForcePushedBranch", "Update Force-Pushed Branch"),
    ("rebased.resetToRemoteBranch", "Reset to the Remote Branch"),
    ("rebased.worktrees.create", "New Worktree…"), ("rebased.worktrees.show", "Worktrees…"),
    ("rebased.worktrees.refresh", "Refresh Worktrees"), ("rebased.worktrees.prune", "Prune Worktrees"),
    ("rebased.worktrees.open", "Open Worktree…"), ("rebased.worktrees.delete", "Delete Worktree…"),
    ("rebased.worktrees.lock", "Lock Worktree"), ("rebased.worktrees.unlock", "Unlock Worktree"),
]
hidden = ["rebased.branch." + a for a in "checkout newBranchFrom checkoutAndRebase checkoutAndUpdate compare showDiffWithWorkingTree rebaseCurrentOnto mergeIntoCurrent pullRebase pullMerge push update rename delete toggleFavorite trackRemote".split()]
hidden += ["rebased.tag." + a for a in "checkout mergeIntoCurrent push delete".split()]
hidden += ["rebased.cherryPick", "rebased.revertCommits", "rebased.undoCommit", "rebased.rewordCommit", "rebased.fixupCommit", "rebased.squashCommits",
           "rebased.dropCommits", "rebased.interactiveRebase", "rebased.checkoutRevision", "rebased.ops.pickToolbarRepository"]
titles = {
    "rebased.cherryPick": "Cherry-Pick", "rebased.revertCommits": "Revert Commit", "rebased.undoCommit": "Undo Commit…",
    "rebased.rewordCommit": "Edit Commit Message…", "rebased.fixupCommit": "Fixup…", "rebased.squashCommits": "Squash Commits…",
    "rebased.dropCommits": "Drop Commits", "rebased.interactiveRebase": "Interactively Rebase from Here…",
    "rebased.checkoutRevision": "Checkout Revision", "rebased.ops.pickToolbarRepository": "Select Toolbar Repository",
}
def icon(name):
    return {"light": f"media/icons/{name}.svg", "dark": f"media/icons/{name}_dark.svg"}

icons = {
    "rebased.worktrees.create": "general/add", "rebased.worktrees.refresh": "general/refresh",
    "rebased.worktrees.delete": "general/delete", "rebased.worktrees.prune": "actions/clearCash",
    "rebased.worktrees.open": "general/open",
}
commands = [{"command": c, "title": t, "category": "Rebased", **({"icon": icon(icons[c])} if c in icons else {})} for c, t in cmds]
commands += [{"command": c, "title": titles.get(c, c.split('.', 1)[1]), "category": "Rebased"} for c in hidden]
palette = [{"command": c, "when": "false"} for c in hidden]
for c in ["rebased.push", "rebased.fetch", "rebased.pull", "rebased.updateProject", "rebased.branches", "rebased.createBranch", "rebased.merge",
          "rebased.rebase", "rebased.resetHead", "rebased.createTag", "rebased.remotes", "rebased.unshallow", "rebased.copyBranchName",
          "rebased.createPatch", "rebased.applyPatch", "rebased.applyPatchFromClipboard",
          "rebased.updateForcePushedBranch", "rebased.resetToRemoteBranch", "rebased.worktrees.create", "rebased.worktrees.show",
          "rebased.worktrees.refresh", "rebased.worktrees.prune", "rebased.worktrees.open", "rebased.worktrees.delete",
          "rebased.worktrees.lock", "rebased.worktrees.unlock"]:
    palette.append({"command": c, "when": "rebased.hasRepository"})
for c in ["rebased.abortOperation", "rebased.continueOperation", "rebased.skipCommit"]:
    palette.append({"command": c, "when": "rebased.operation && rebased.operation != 'none'"})

when = "config.rebased.intellijShortcuts"
keys = [
    {"command": "rebased.push", "key": "ctrl+shift+k", "mac": "cmd+shift+k", "when": when + " && !editorTextFocus"},
    {"command": "rebased.push", "key": "ctrl+shift+k", "mac": "cmd+shift+k", "when": when + " && editorTextFocus && config.rebased.intellijShortcutsInEditor"},
    {"command": "rebased.updateProject", "key": "ctrl+t", "mac": "cmd+t", "when": when},
    {"command": "rebased.branches", "key": "ctrl+shift+`", "mac": "cmd+shift+`", "when": when},
    {"command": "rebased.vcsOperationsPopup", "key": "alt+`", "mac": "ctrl+v", "when": when + " && !terminalFocus && !editorTextFocus"},
    {"command": "rebased.createBranch", "key": "ctrl+alt+n", "mac": "alt+cmd+n", "when": when + " && rebased.hasRepository"},
]
config = {"title": "Rebased", "properties": {
    "rebased.intellijShortcuts": {"type": "boolean", "default": True, "description": "Use IntelliJ keyboard shortcuts for Git actions (Ctrl+T Update Project, Ctrl+Shift+K Push, Ctrl+Shift+` Branches, Alt+` VCS Operations Popup, Ctrl+Alt+N New Branch)."},
    "rebased.intellijShortcutsInEditor": {"type": "boolean", "default": False, "description": "Also use Ctrl+Shift+K for Push while a text editor has focus (it replaces VS Code's Delete Line)."},
    "rebased.updateMethod": {"type": "string", "enum": ["merge", "rebase", "branchDefault"], "enumDescriptions": ["Merge incoming changes into the current branch", "Rebase the current branch on top of incoming changes", "Branch Default (git config branch.<name>.rebase / pull.rebase)"], "default": "merge", "description": "Update method used by Update Project."},
    "rebased.update.showDialog": {"type": "boolean", "default": True, "description": "Show the Update Project dialog before updating."},
    "rebased.update.saveChangesPolicy": {"type": "string", "enum": ["stash", "shelve"], "default": "stash", "enumDescriptions": ["Using Stash", "Using Shelve"], "description": "Clean working tree using: Stash / Shelve. Local changes are saved before Update Project, Smart Checkout and Smart Merge, and restored afterwards."},
    "rebased.push.tags": {"type": "string", "enum": ["none", "all", "current"], "default": "none", "description": "Push tags option of the Push dialog."},
    "rebased.push.runHooks": {"type": "boolean", "default": True, "description": "Run Git hooks on push."},
    "rebased.push.autoUpdateOnRejected": {"type": "string", "enum": ["", "merge", "rebase"], "default": "", "description": "Update method to use silently when a push is rejected. Empty: ask with the Push Rejected dialog."},
    "rebased.fetch.prune": {"type": "boolean", "default": False, "description": "Prune obsolete remote references on fetch."},
    "rebased.branches.showRecent": {"type": "boolean", "default": True, "description": "Show recent branches in the branches popup."},
    "rebased.branches.showTags": {"type": "boolean", "default": True, "description": "Show tags in the branches popup."},
    "rebased.branches.syncControl": {"type": "boolean", "default": True, "description": "Execute branch operations on all roots: with several repositories, branches that exist in all of them are shown once in the branches popup and their actions run in every repository."},
    "rebased.statusBar.enabled": {"type": "boolean", "default": True, "description": "Show the Git toolbar widgets (Update Project, Push, branch, merge/rebase actions) in the status bar."},
}}
wt = "view == rebased.worktrees"
menus = {
    "commandPalette": palette,
    "view/title": [
        {"command": "rebased.worktrees.create", "when": wt, "group": "navigation@1"},
        {"command": "rebased.worktrees.refresh", "when": wt, "group": "navigation@2"},
        {"command": "rebased.worktrees.delete", "when": wt, "group": "navigation@3"},
        {"command": "rebased.worktrees.prune", "when": wt, "group": "navigation@4"},
    ],
    "view/item/context": [
        {"command": "rebased.worktrees.open", "when": wt + " && viewItem =~ /^worktree/", "group": "1_open@1"},
        {"command": "rebased.worktrees.lock", "when": wt + " && viewItem =~ / linked / && viewItem =~ / unlocked/", "group": "1_open@2"},
        {"command": "rebased.worktrees.unlock", "when": wt + " && viewItem =~ / locked/", "group": "1_open@2"},
        {"command": "rebased.worktrees.delete", "when": wt + " && viewItem =~ / linked /", "group": "2_delete@1"},
    ],
}
views = {"rebased-panel": [{"id": "rebased.worktrees", "name": "Worktrees", "when": "rebased.hasRepository"}]}
welcome = [{"view": "rebased.worktrees", "contents": "No linked worktrees\n[Create worktree…](command:rebased.worktrees.create)\n[What is a Git worktree](https://git-scm.com/docs/git-worktree)"}]
out = {"commands": commands, "menus": menus, "keybindings": keys, "configuration": config, "views": views, "viewsWelcome": welcome}
with open('contrib/30-ops.json', 'w') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write('\n')
