// E2E: Smart Merge whose unstash conflicts, like IntelliJ's GitPreservingProcess.
// - Merge… with local changes to a file the merged branch also changes: "Git Merge Problem" → Smart Merge.
// - The Conflicts dialog opens by itself: "Uncommitted changes that were saved before merge have conflicts with
//   files from other"; the merge window shows "Uncommitted changes from the stash" / "Changes from other".
// - Resolved in the merge window: no "Local changes were restored with conflicts" notification; the stash is kept.
// - The one-time question about VS Code's conflict UI: "Use IdeaGitTool" writes the three settings.
// - A conflicted file in the editor: our CodeLens and editor title action, no built-in CodeLens; the CodeLens
//   opens the Conflicts dialog with the merge window of the file.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const sh = (cwd, cmd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();

async function findFrame(window, selector, text, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of window.frames()) {
      const el = await f.$(selector).catch(() => null);
      if (!el) continue;
      if (!text || (await el.textContent().catch(() => '')).includes(text)) return f;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`frame with ${selector}${text ? ` containing ${text}` : ''} not found`);
}

const check = (cond, message) => {
  if (!cond) throw new Error(message);
  console.log('OK:', message);
};

const toasts = window => window.$$eval('.notification-toast', els => els.map(e => e.textContent ?? ''));

export async function run({ window, shot, command, sleep, workspace, userData }) {
  sh(workspace, 'git stash -u -q');
  const base = ['a', 'b', 'c', 'd', 'e', ''].join('\n');
  writeFileSync(`${workspace}/src/app.py`, base);
  const go = 'package main\n\nimport "fmt"\n\nfunc helper() {}\n\nfunc main() {}\n';
  const rs = 'use std::io;\n\nfn helper() {}\n\nfn main() {}\n';
  writeFileSync(`${workspace}/src/main.go`, go);
  writeFileSync(`${workspace}/src/lib.rs`, rs);
  sh(workspace, 'git add -A && git commit -qm "base for smart merge"');
  sh(workspace, 'git checkout -q -b other');
  writeFileSync(`${workspace}/src/app.py`, base.replace('b\n', 'b from other\n'));
  writeFileSync(`${workspace}/src/main.go`, go.replace('func main() {}', 'func main() { run() }'));
  writeFileSync(`${workspace}/src/lib.rs`, rs.replace('fn main() {}', 'fn main() { run() }'));
  sh(workspace, 'git commit -qam "other change"');
  sh(workspace, 'git checkout -q master');
  // Local changes: app.py conflicts with other, main.go and lib.rs only block the merge.
  writeFileSync(`${workspace}/src/app.py`, base.replace('b\n', 'b local\n'));
  writeFileSync(`${workspace}/src/main.go`, `// local\n${go}`);
  writeFileSync(`${workspace}/src/lib.rs`, `// local\n${rs}`);
  const unmerged = () => sh(workspace, 'git diff --name-only --diff-filter=U').trim().split('\n').filter(Boolean);
  const file = f => readFileSync(`${workspace}/${f}`, 'utf8');
  await sleep(4000);

  await command('IdeaGitTool: Merge…');
  let dlg = await findFrame(window, '.dialog', 'Merge into');
  await sleep(800);
  await dlg.fill('.dialog input', 'other');
  await sleep(300);
  await window.keyboard.press('Escape').catch(() => undefined);
  await (await dlg.$('button:has-text("Merge")')).click();
  dlg = await findFrame(window, '.dialog', 'Smart Merge');
  await sleep(800);
  await shot('smart-merge-problem');
  check((await dlg.textContent('.file-list')).includes('main.go'), 'Git Merge Problem lists the files');
  await (await dlg.$('button:has-text("Smart Merge")')).click();

  // The Conflicts dialog opens by itself.
  dlg = await findFrame(window, '.conflicts-description', 'Uncommitted changes that were saved before merge', 20000);
  await sleep(1500);
  await shot('smart-merge-conflicts-dialog');
  const description = (await dlg.textContent('.conflicts-description')).trim();
  check(description === 'Uncommitted changes that were saved before merge have conflicts with files from other', `dialog description: ${description}`);
  check(unmerged().join() === 'src/app.py', `app.py is unmerged after unstash: ${unmerged()} ${sh(workspace, 'git status --short')}`);
  check(sh(workspace, 'git stash list').includes('Uncommitted changes before merge'), 'the stash is kept while conflicts remain');
  const notes = await toasts(window);
  check(!notes.some(t => t.includes('Local changes were restored with conflicts')), 'no "restored with conflicts" notification while the dialog is open');
  check(notes.some(t => t.includes('Resolve merge conflicts with IdeaGitTool?')), 'the question about the VS Code conflict UI is asked');
  await shot('smart-merge-consent');

  // Merge window titles of the restore conflict (reverse: the stash on the left).
  await (await dlg.$('tr.conflicts-file[data-key$="src/app.py"]')).dblclick();
  let mg = await findFrame(window, '.mg-root', 'b local');
  await sleep(1500);
  await shot('smart-merge-window');
  const titles = await mg.$$eval('.mg-title', els => els.map(e => e.textContent?.trim()));
  check(titles[0] === 'Uncommitted changes from the stash' && titles[1] === 'Result' && titles[2] === 'Changes from other', `merge window titles: ${titles.join(' | ')}`);
  // Accept the local change (left), ignore the other side, then Apply.
  await (await mg.$('.mg-left .mg-op[data-i="0"][data-action="apply"]')).click();
  await sleep(500);
  await (await mg.$('.mg-right .mg-op[data-i="0"][data-action="ignore"]')).click();
  await sleep(500);
  await (await mg.$('button:has-text("Apply Changes")')).click();
  await sleep(2000);
  dlg = await findFrame(window, '.conflicts-description', 'All conflicts have been resolved');
  await (await dlg.$('button:has-text("Accept and Finish")')).click();
  await sleep(3000);
  check(unmerged().length === 0, 'Accept and Finish resolved app.py');
  check(file('src/app.py') === base.replace('b\n', 'b local\n'), 'app.py keeps the local change');
  check(file('src/main.go').startsWith('// local') && file('src/main.go').includes('run()'), 'main.go restored onto the merged version');
  check(sh(workspace, 'git log -1 --format=%s') === 'other change\n', 'master fast-forwarded to other');
  check(sh(workspace, 'git stash list').includes('Uncommitted changes before merge'), 'the stash is kept after resolving (IntelliJ: drop it yourself)');
  check(!(await toasts(window)).some(t => t.includes('Local changes were restored with conflicts')), 'no notification when every conflict was resolved');

  // The consent question: Use IdeaGitTool.
  const toast = await window.$('.notification-toast:has-text("Resolve merge conflicts with IdeaGitTool?")');
  await (await toast.$('a.monaco-button:has-text("Use IdeaGitTool"), .monaco-button:has-text("Use IdeaGitTool")')).click();
  await sleep(2500);
  const user = JSON.parse(readFileSync(`${userData}/User/settings.json`, 'utf8'));
  check(user['merge-conflict.codeLens.enabled'] === false && user['merge-conflict.decorators.enabled'] === false, 'merge-conflict CodeLens and decorators turned off');
  check(user['ideagittool.merge.handleConflicts'] === 'always', 'answer remembered in ideagittool.merge.handleConflicts');
  check(!('git.mergeEditor' in user), 'git.mergeEditor at its default (off) is left alone');

  // A conflicted file in the editor.
  sh(workspace, 'git stash drop -q && git commit -qam "resolved" && git checkout -q -b other2');
  writeFileSync(`${workspace}/src/app.py`, file('src/app.py').replace('d\n', 'd from other2\n'));
  sh(workspace, 'git commit -qam "other2" && git checkout -q master');
  writeFileSync(`${workspace}/src/app.py`, file('src/app.py').replace('d\n', 'd from master\n'));
  sh(workspace, 'git commit -qam "master d" && (git merge other2 || true)');
  await sleep(3000);
  // The Commit tool window took the focus with the dialog; open the file with Quick Open.
  await window.evaluate(() => (document.activeElement)?.blur?.());
  await window.keyboard.press('Control+P');
  await sleep(600);
  await window.keyboard.type('app.py');
  await sleep(800);
  await window.keyboard.press('Enter');
  await sleep(3000);
  await shot('conflict-editor');
  const lenses = await window.$$eval('.contentWidgets .codelens-decoration, .codelens-decoration', els => els.map(e => e.textContent ?? ''));
  console.log('LENSES', JSON.stringify(lenses));
  check(lenses.some(t => t.includes('Resolve Conflicts… (IdeaGitTool)')), 'our CodeLens at the conflict marker');
  check(!lenses.some(t => t.includes('Accept Current Change')), 'no built-in merge-conflict CodeLens');
  const titleAction = await window.$('.editor-actions [aria-label="Resolve Conflicts… (IdeaGitTool)"], .editor-actions a[title^="Resolve Conflicts"]');
  check(!!titleAction, 'editor title action "Resolve Conflicts… (IdeaGitTool)"');
  await (await window.$('.codelens-decoration a:has-text("Resolve Conflicts")')).click();
  mg = await findFrame(window, '.mg-root', 'd from other2');
  await sleep(1500);
  await shot('conflict-editor-merge-window');
  const t2 = await mg.$$eval('.mg-title', els => els.map(e => e.textContent?.trim()));
  check(t2[0] === 'Changes from master' && t2[2] === 'Changes from other2', `merge titles for the merge: ${t2.join(' | ')}`);
  console.log('E2E SMART MERGE OK');
}
