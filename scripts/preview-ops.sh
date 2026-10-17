#!/bin/sh
# Renders every ops dialog fixture into $1 (directory).
out="$1"
mkdir -p "$out"
for k in reset newBranch update rebase pull tag remotes smartOperation pushRejected clone commitMessage; do
  theme=""
  if [ "$k" = rebase ] || [ "$k" = tag ]; then theme="--light"; fi
  DIALOG="ops.$k" node scripts/preview.mjs dialog test/fixtures/ops-dialogs.mjs "$out/$k.png" --size=760x520 $theme | grep -i error
done
exit 0
