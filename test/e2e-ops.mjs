// E2E scenario for the ops feature: status bar widgets, branches popup, branch submenu, push and merge dialogs.
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export async function run({ window, shot, command, sleep, workspace }) {
  // Give the sample repository a remote so that push has something to show.
  const bare = mkdtempSync(resolve(tmpdir(), 'ideagittool-bare-'));
  execSync('git init -q --bare -b master', { cwd: bare });
  execSync(`git remote add origin ${bare} && git push -q -u origin master~2:refs/heads/master && git branch -u origin/master master && git fetch -q`, { cwd: workspace });
  await sleep(3000);
  await shot('ops-statusbar');
  await command('IdeaGitTool: Branches…');
  await sleep(800);
  await shot('ops-branches-popup');
  await window.keyboard.type('feature/shelf');
  await sleep(400);
  await window.keyboard.press('Enter');
  await sleep(800);
  await shot('ops-branch-actions');
  await window.keyboard.press('Escape');
  await sleep(500);
  await command('IdeaGitTool: Push…');
  await sleep(2500);
  await shot('ops-push-dialog');
  await window.keyboard.press('Escape');
  await sleep(800);
  await command('IdeaGitTool: Merge…');
  await sleep(2500);
  await shot('ops-merge-dialog');
  await window.keyboard.press('Escape');
  await sleep(500);
  await command('IdeaGitTool: Git Menu…');
  await sleep(800);
  await shot('ops-main-menu');
}
