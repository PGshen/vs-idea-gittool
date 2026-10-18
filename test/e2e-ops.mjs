// E2E scenario for the ops feature: the log in the bottom panel at startup, the Branches tab of the Commit tool window
// (search, branch submenu, checkout, favorite, New Branch…), then the Push and Merge dialogs and the Git menu.
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: 'pipe' }).toString().trim();

async function findFrame(window, selector, sleep, tries = 40) {
  for (let i = 0; i < tries; i++) {
    for (const f of window.frames()) {
      try {
        if (await f.$(selector)) return f;
      } catch {
        // detached frame
      }
    }
    await sleep(250);
  }
  throw new Error(`frame with ${selector} not found`);
}

async function rowByText(frame, selector, text) {
  for (const row of await frame.$$(selector)) if ((await row.textContent()).includes(text)) return row;
  throw new Error(`row "${text}" not found`);
}

export async function run({ window, shot, command, sleep, workspace }) {
  // Give the sample repository a remote so that push has something to show.
  const bare = mkdtempSync(resolve(tmpdir(), 'ideagittool-bare-'));
  execSync('git init -q --bare -b master', { cwd: bare });
  execSync(`git remote add origin ${bare} && git push -q -u origin master~2:refs/heads/master && git branch -u origin/master master && git fetch -q`, { cwd: workspace });
  // The sample's README edit would block the checkout of feature/shelf (Git Checkout Problem); drop it.
  execSync('git checkout -- README.md', { cwd: workspace });
  await sleep(3000);

  // The log is shown in the "Git" panel at the bottom, not in an editor tab.
  await findFrame(window, '.log-row', sleep);
  const editorTabs = await window.$$eval('.editor .tabs-container .tab .label-name', els => els.map(e => e.textContent));
  if (editorTabs.some(t => /^Log/.test(t ?? ''))) throw new Error(`log opened in the editor: ${editorTabs}`);
  if (!(await window.isVisible('.part.panel'))) throw new Error('bottom panel is not visible');
  await shot('ops-log-panel');
  console.log('OK: log in the bottom panel');

  // Ctrl+Shift+` / "Branches…" reveals the Branches tab and focuses its search field.
  await command('IdeaGitTool: Branches…');
  const tab = await findFrame(window, '.branches-row', sleep);
  await sleep(600);
  await shot('ops-branches-tab');
  const focused = await tab.evaluate(() => document.activeElement?.className ?? '');
  if (!focused.includes('branches-search-input')) throw new Error(`search not focused: ${focused}`);
  console.log('OK: Branches tab with focused search');

  // Speed search, then the branch submenu.
  await tab.fill('.branches-search-input', 'shelf');
  await sleep(500);
  await shot('ops-branches-search');
  const shelf = await rowByText(tab, '.branches-row.branch', 'shelf');
  await shelf.click();
  await sleep(900);
  await shot('ops-branch-actions');
  const checkout = await rowByText(tab, '.popup .menu-item', 'Checkout');
  const items = await tab.$$eval('.popup .menu-item', els => els.map(e => e.textContent));
  if (!items.some(t => t.includes("Merge 'feature/shelf' into 'master'"))) throw new Error(`unexpected submenu: ${items}`);
  await checkout.click();
  await sleep(3000);
  if (git(workspace, 'branch --show-current') !== 'feature/shelf') throw new Error('checkout from the submenu failed');
  console.log('OK: checkout from the branch submenu');

  // Favorite toggle with the star of a row.
  await tab.fill('.branches-search-input', '');
  await sleep(500);
  const graph = await rowByText(tab, '.branches-row.branch', 'log-graph');
  await graph.hover();
  await sleep(200);
  await (await graph.$('.star-toggle')).click();
  await sleep(1200);
  const star = await (await rowByText(tab, '.branches-row.branch', 'log-graph')).$eval('.star-toggle img', i => i.getAttribute('src'));
  if (!/nodes\/star(_dark)?\.svg/.test(star)) throw new Error(`favorite not shown: ${star}`);
  console.log('OK: favorite toggled');

  // New Branch… from the top actions.
  await (await rowByText(tab, '.branches-row.action', 'New Branch…')).click();
  const dlg = await findFrame(window, '.dialog input', sleep);
  await sleep(500);
  await dlg.fill('.dialog input:not([type=checkbox])', 'e2e/new-branch');
  await sleep(300);
  await shot('ops-new-branch-dialog');
  await dlg.press('.dialog input:not([type=checkbox])', 'Enter');
  await sleep(2500);
  if (git(workspace, 'branch --show-current') !== 'e2e/new-branch') throw new Error('New Branch… did not create and check out the branch');
  console.log('OK: New Branch… from the Branches tab');
  const tab2 = await findFrame(window, '.branches-row', sleep);
  await sleep(800);
  if (!(await tab2.$$eval('.branches-row', els => els.some(e => e.textContent?.includes('new-branch'))))) throw new Error('Branches tab did not refresh');
  await shot('ops-branches-after');

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
  await window.keyboard.press('Escape');
  // No IdeaGitTool status bar widgets any more.
  const bar = await window.$$eval('.statusbar-item', els => els.map(e => e.id));
  if (bar.some(id => id.includes('ideagittool'))) throw new Error(`status bar widgets still present: ${bar}`);
  console.log('E2E OPS OK');
}
