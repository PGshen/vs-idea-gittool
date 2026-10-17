#!/bin/sh
# Renders the main views and dialogs in the VS Code appearance into $1 (directory), theme $2 (dark | light).
out="$1"; t="${2:-dark}"
mkdir -p "$out"
p() { name="$1"; shift; node scripts/preview.mjs "$@" "--vscode=$t" >/dev/null 2>&1 || echo "failed: $name"; }
p log log test/fixtures/log.mjs "$out/log-$t.png" --size=1400x800
ACT=menu p logmenu log test/fixtures/log.mjs "$out/log-menu-$t.png" --size=1400x800
p commit commit test/fixtures/commit.mjs "$out/commit-$t.png" --size=380x800
MENU=1 p commitmenu commit test/fixtures/commit.mjs "$out/commit-menu-$t.png" --size=380x800
p push dialog test/fixtures/ops-push.mjs "$out/push-$t.png" --size=1100x700
p irebase dialog test/fixtures/ops-irebase.mjs "$out/irebase-$t.png" --size=1100x700
KIND=commit.conflicts p conflicts dialog test/fixtures/commit-dialogs.mjs "$out/conflicts-$t.png" --size=1000x600
DIALOG=ops.newBranch p newbranch dialog test/fixtures/ops-dialogs.mjs "$out/newbranch-$t.png" --size=760x420
DIALOG=ops.pull p pull dialog test/fixtures/ops-dialogs.mjs "$out/pull-$t.png" --size=900x480
p merge merge test/fixtures/merge.mjs "$out/merge-$t.png" --size=1400x700
p lh localHistory test/fixtures/localHistory.mjs "$out/localhistory-$t.png" --size=1400x700
exit 0
