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
commands = [{"command": c, "title": t, "category": "Rebased"} for c, t in cmds]
commands += [{"command": c, "title": titles.get(c, c.split('.', 1)[1]), "category": "Rebased"} for c in hidden]
palette = [{"command": c, "when": "false"} for c in hidden]
for c in ["rebased.push", "rebased.fetch", "rebased.pull", "rebased.updateProject", "rebased.branches", "rebased.createBranch", "rebased.merge",
          "rebased.rebase", "rebased.resetHead", "rebased.createTag", "rebased.remotes", "rebased.unshallow", "rebased.copyBranchName",
          "rebased.createPatch", "rebased.applyPatch", "rebased.applyPatchFromClipboard"]:
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
    "rebased.update.saveChangesPolicy": {"type": "string", "enum": ["stash", "shelve"], "default": "stash", "description": "Clean working tree before update using stash or shelve. Local changes are kept with git --autostash."},
    "rebased.push.tags": {"type": "string", "enum": ["none", "all", "current"], "default": "none", "description": "Push tags option of the Push dialog."},
    "rebased.push.runHooks": {"type": "boolean", "default": True, "description": "Run Git hooks on push."},
    "rebased.push.autoUpdateOnRejected": {"type": "string", "enum": ["", "merge", "rebase"], "default": "", "description": "Update method to use silently when a push is rejected. Empty: ask with the Push Rejected dialog."},
    "rebased.fetch.prune": {"type": "boolean", "default": False, "description": "Prune obsolete remote references on fetch."},
    "rebased.branches.showRecent": {"type": "boolean", "default": True, "description": "Show recent branches in the branches popup."},
    "rebased.branches.showTags": {"type": "boolean", "default": True, "description": "Show tags in the branches popup."},
    "rebased.statusBar.enabled": {"type": "boolean", "default": True, "description": "Show the Git toolbar widgets (Update Project, Push, branch, merge/rebase actions) in the status bar."},
}}
out = {"commands": commands, "menus": {"commandPalette": palette}, "keybindings": keys, "configuration": config}
with open('contrib/30-ops.json', 'w') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write('\n')
