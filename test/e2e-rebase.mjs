// E2E: interactive rebase from the log context menu inside real VS Code (sequence editor runs on VS Code's
// Electron with ELECTRON_RUN_AS_NODE). Reword + squash + edit-stop + continue, then a second rebase that drops a commit.
import { execSync } from 'node:child_process';

const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: 'pipe' }).toString();
const subjects = cwd => git(cwd, 'log --format=%s -6').trim().split('\n');

async function findFrame(window, selector, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of window.frames()) {
      const el = await f.$(selector).catch(() => null);
      if (el) return f;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`frame with ${selector} not found`);
}

async function rowByText(frame, selector, text) {
  for (const row of await frame.$$(selector)) {
    if ((await row.textContent()).includes(text)) return row;
  }
  throw new Error(`row "${text}" not found`);
}

async function openRebaseFrom(window, sleep, subject) {
  const log = await findFrame(window, '.log-row');
  const row = await rowByText(log, '.log-row', subject);
  await row.click();
  await sleep(500);
  await row.click({ button: 'right' });
  await sleep(600);
  const item = await rowByText(log, '.menu-item', 'Interactively Rebase from Here');
  await item.click();
  return findFrame(window, '.irebase-table');
}

export async function run({ window, shot, command, sleep, workspace }) {
  await sleep(4000);
  const before = subjects(workspace);
  console.log('before:', before);

  // 1st rebase: reword "fix zizmor errors", squash "update android repo" into it, stop at "readme" for editing.
  let dlg = await openRebaseFrom(window, sleep, 'fix zizmor errors');
  await sleep(800);
  await shot('rebase-dialog-open');
  const select = async text => {
    const r = await rowByText(dlg, '.irebase-row', text);
    await r.click();
    await sleep(200);
  };
  // Squash opens the message editor for the squashed group (IntelliJ: "Squashed Commit Message").
  await select('update android repo');
  await window.keyboard.press('s');
  await sleep(400);
  const area = await dlg.$('.irebase-reword-area');
  if (!area) throw new Error('squash message editor did not open');
  const combined = await area.inputValue();
  console.log('combined message:', JSON.stringify(combined));
  if (!combined.includes('fix zizmor errors') || !combined.includes('update android repo')) throw new Error('combined squash message is wrong');
  await area.fill('fix zizmor errors (reworded in VS Code)');
  await area.press('Control+Enter');
  await sleep(300);
  await select('readme');
  await window.keyboard.press('e');
  await sleep(300);
  await shot('rebase-dialog-edited');
  const startBtn = await rowByText(dlg, 'button', 'Start Rebasing');
  await startBtn.click();
  await sleep(5000);
  await shot('rebase-stopped');
  const status = git(workspace, 'status');
  console.log('status after start:', status.split('\n').slice(0, 3).join(' | '));
  if (!/rebase in progress|interactive rebase in progress/.test(status)) throw new Error('rebase did not stop at the edit entry');
  await window.keyboard.press('Escape');
  await command('IdeaGitTool: Continue Rebase');
  await sleep(4000);
  const afterFirst = subjects(workspace);
  console.log('after 1st rebase:', afterFirst);
  if (/rebase in progress/.test(git(workspace, 'status'))) throw new Error('rebase still in progress after continue');
  if (afterFirst[0] !== 'readme') throw new Error('readme should stay on top');
  if (afterFirst[1] !== 'fix zizmor errors (reworded in VS Code)') throw new Error(`reword/squash failed: ${afterFirst[1]}`);
  if (afterFirst.includes('update android repo')) throw new Error('squashed commit still present');
  if (!git(workspace, 'show --stat --format= HEAD~1').includes('src/file')) throw new Error('squash lost changes');

  // 2nd rebase: drop the reworded commit.
  await sleep(2000);
  dlg = await openRebaseFrom(window, sleep, 'fix zizmor errors (reworded');
  await sleep(800);
  const r = await rowByText(dlg, '.irebase-row', 'reworded in VS Code');
  await r.click();
  await window.keyboard.press('Delete');
  await sleep(300);
  await (await rowByText(dlg, 'button', 'Start Rebasing')).evaluate(b => b.click()); // the dialog closes during the click
  await sleep(5000);
  const afterSecond = subjects(workspace);
  console.log('after 2nd rebase:', afterSecond);
  if (afterSecond.some(s => s.includes('reworded'))) throw new Error('drop failed');
  if (afterSecond[0] !== 'readme') throw new Error('readme should stay on top after drop');
  // Local changes survive (autostash).
  if (!git(workspace, 'status --porcelain').includes('src/file1.ts')) throw new Error('local changes lost');
  await shot('rebase-done');
  console.log('E2E REBASE OK');
}
