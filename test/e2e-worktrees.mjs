// E2E: New Worktree dialog, Worktrees view, and the branches popup entries for a branch checked out in another worktree.
import { execSync } from 'node:child_process';

const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: 'pipe' }).toString();

async function findFrame(window, selector, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of window.frames()) {
      if (await f.$(selector).catch(() => null)) return f;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`frame with ${selector} not found`);
}

export async function run({ app, window, shot, command, sleep, workspace }) {
  await sleep(4000);
  await command('Rebased: New Worktree…');
  const dlg = await findFrame(window, '.dialog');
  await sleep(600);
  await shot('worktree-dialog');
  // master is checked out here, so create a new branch for the worktree.
  const box = await dlg.$('label.checkbox input');
  await box.check();
  await (await dlg.$('.form-row:has(label.checkbox) input.text-field')).fill('topic');
  await sleep(300);
  await shot('worktree-dialog-filled');
  for (const b of await dlg.$$('button.btn.primary')) await b.click();
  await sleep(5000);
  const list = git(workspace, 'worktree list');
  console.log(list);
  if (!/\[topic\]/.test(list)) throw new Error('worktree with branch topic was not created');
  // The new worktree opens in a new window; continue in the first one.
  console.log('windows:', app.windows().length);
  await window.bringToFront();
  await command('Rebased: Worktrees…');
  await sleep(1500);
  await shot('worktrees-view');
  // Checking out "topic" here hits the worktree conflict.
  await command('Rebased: Branches…');
  await sleep(800);
  await window.keyboard.type('topic');
  await sleep(400);
  await window.keyboard.press('Enter');
  await sleep(800);
  await shot('worktree-branch-actions');
  await window.keyboard.press('Escape');
  console.log('E2E WORKTREES OK');
}
