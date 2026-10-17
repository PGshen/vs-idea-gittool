// E2E: a merge with a conflict, the Conflicts dialog, then VS Code's 3-way merge editor via "Merge…".
import { execSync } from 'node:child_process';

const sh = (cwd, cmd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();

async function findFrame(window, selector, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of window.frames()) if (await f.$(selector).catch(() => null)) return f;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`frame with ${selector} not found`);
}

export async function run({ window, shot, command, sleep, workspace }) {
  sh(workspace, 'git stash -u -q');
  sh(workspace, 'git checkout -q -b other && printf "a\\nfrom other branch\\nc\\n" > src/conflict.ts && git add -A && git commit -qm "other change"');
  sh(workspace, 'git checkout -q master && printf "a\\nfrom master\\nc\\n" > src/conflict.ts && git add -A && git commit -qm "master change"');
  sh(workspace, 'git merge other || true');
  await sleep(4000);
  await command('Rebased: Resolve Conflicts');
  await sleep(2500);
  await shot('conflicts-dialog');
  const dlg = await findFrame(window, '.dialog');
  const row = await dlg.$("text=src/conflict.ts");
  await row.click();
  await sleep(300);
  const btn = await dlg.$('button:has-text("Resolve Manually")');
  await btn.click();
  await sleep(4000);
  await shot('merge-editor');
  // Saving alone must not mark the file as resolved.
  await window.keyboard.press('Control+S');
  await sleep(1500);
  const unmerged = () => sh(workspace, 'git diff --name-only --diff-filter=U').trim();
  if (unmerged() !== 'src/conflict.ts') throw new Error('file was staged on save');
  console.log('OK: still unresolved after save');
  // Accept both sides, save, close the merge editor: now it is resolved.
  await window.click('text=Accept Combination (Yours (master) First)');
  await sleep(800);
  await shot('merge-editor-accepted');
  await window.keyboard.press('Control+S');
  await sleep(800);
  await window.keyboard.press('Control+W');
  await sleep(2500);
  await shot('merge-resolved');
  const content = sh(workspace, 'cat src/conflict.ts');
  console.log('RESULT', JSON.stringify(content));
  if (unmerged() !== '') throw new Error('file not marked resolved after closing the merge editor');
  if (!content.includes('from master') || !content.includes('from other branch')) throw new Error('unexpected result');
  console.log('E2E CONFLICTS OK');
}
