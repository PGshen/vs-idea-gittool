// E2E: the iterative Conflicts dialog and IntelliJ's three-pane merge window on a merge with conflicts in three files.
// - second.ts: the inline "Accept" button of the Yours column.
// - conflict.ts: a gutter operation, "Save and Close" (partial result saved, badge 1/3), reopen and continue:
//   the result editor context menu, the append operation, a manual edit, "Apply Changes".
// - third.ts (opened next automatically): magic resolve of a conflict in different words of one line.
// Finally "Accept and Finish" marks every file resolved.
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

export async function run({ window, shot, command, sleep, workspace }) {
  sh(workspace, 'git stash -u -q');
  const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', ''].join('\n');
  writeFileSync(`${workspace}/src/conflict.ts`, base);
  writeFileSync(`${workspace}/src/second.ts`, 'one\ntwo\n');
  writeFileSync(`${workspace}/src/third.ts`, 'let x = 1 + 2;\n');
  sh(workspace, 'git add -A && git commit -qm "base for conflicts"');
  sh(workspace, 'git checkout -q -b other');
  writeFileSync(`${workspace}/src/conflict.ts`, base.replace('b\n', 'b from other\n').replace('g\n', 'g\nh from other\n'));
  writeFileSync(`${workspace}/src/second.ts`, 'one\ntwo from other\n');
  writeFileSync(`${workspace}/src/third.ts`, 'let x = 1 + 20;\n');
  sh(workspace, 'git commit -qam "other change"');
  sh(workspace, 'git checkout -q master');
  writeFileSync(`${workspace}/src/conflict.ts`, base.replace('b\n', 'b from master\n').replace('d\n', 'd from master\n'));
  writeFileSync(`${workspace}/src/second.ts`, 'one\ntwo from master\n');
  writeFileSync(`${workspace}/src/third.ts`, 'let x = 10 + 2;\n');
  sh(workspace, 'git commit -qam "master change"');
  sh(workspace, 'git merge other || true');
  const unmerged = () => sh(workspace, 'git diff --name-only --diff-filter=U').trim().split('\n').filter(Boolean);
  const file = f => readFileSync(`${workspace}/${f}`, 'utf8');
  await sleep(4000);
  await command('Rebased: Resolve Conflicts');
  await sleep(2500);
  let dlg = await findFrame(window, '.dialog', 'Conflicts');
  await shot('conflicts-dialog');
  check((await dlg.textContent('.conflicts-actions')).includes('Resolve All Simple Conflicts'), 'dialog shows "Resolve All Simple Conflicts"');

  // second.ts: the inline Accept button of the "Yours" column (shown on the hovered row).
  const row = path => dlg.$(`tr.conflicts-file[data-key$="${path}"]`);
  await (await row('src/second.ts')).hover();
  await sleep(300);
  await (await (await row('src/second.ts')).$('td:nth-child(2) .conflicts-accept')).click();
  await sleep(2500);
  check(file('src/second.ts') === 'one\ntwo from master\n', 'inline Accept wrote yours to second.ts');
  const group = async path => (await dlg.$eval(`tr.conflicts-file[data-key$="${path}"]`, tr => {
    let g = tr.previousElementSibling;
    while (g && !g.classList.contains('conflicts-group')) g = g.previousElementSibling;
    return g?.textContent ?? '';
  }));
  check((await group('src/second.ts')).includes('Resolved'), 'second.ts moved to the Resolved group');
  await shot('conflicts-dialog-accepted');

  // conflict.ts: apply the non-conflicting "d from master" with the gutter operation, then Save and Close.
  await (await row('src/conflict.ts')).click();
  await sleep(300);
  await (await dlg.$('button:has-text("Resolve Manually")')).click();
  let mg = await findFrame(window, '.mg-root', 'd from master');
  await sleep(1500);
  await shot('merge-window');
  const status = async () => (await mg.textContent('.mg-status')).trim();
  console.log('STATUS', await status());
  await (await mg.$('.mg-left .mg-op[data-i="1"][data-action="apply"]')).click();
  await sleep(500);
  check((await status()) === '1 change, 1 conflict', 'gutter apply resolved the left change');
  await (await mg.$('button:has-text("Save and Close")')).click();
  await sleep(2500);
  check(file('src/conflict.ts') === 'a\nb\nc\nd from master\ne\nf\ng\n', 'Save and Close wrote the partial result');
  check(unmerged().includes('src/conflict.ts'), 'conflict.ts is still unmerged in git');
  dlg = await findFrame(window, '.dialog', 'Conflicts');
  const badge = await (await row('src/conflict.ts')).$eval('.conflicts-badge', b => b.textContent);
  check(badge === '1/3', `conflict.ts badge is 1/3 (${badge})`);
  check((await group('src/conflict.ts')).includes('Unresolved'), 'conflict.ts stays in the Unresolved group');
  await shot('conflicts-dialog-partial');

  // Reopen: the merge window continues from the saved state.
  await (await row('src/conflict.ts')).dblclick();
  mg = await findFrame(window, '.mg-root', 'd from master');
  await sleep(1500);
  check((await status()) === '1 change, 1 conflict', 'reopened window continues (1 change, 1 conflict)');
  // Context menu of the result editor on the conflict: Accept Left Side.
  const line2 = await mg.$('.mg-result .cm-line >> nth=1');
  await line2.click({ button: 'right' });
  await sleep(500);
  await shot('merge-context-menu');
  await (await mg.$('.popup >> text=Accept Left Side')).click();
  await sleep(500);
  // Then append the right side and apply "h from other".
  await (await mg.$('.mg-right .mg-op[data-i="0"][data-action="apply"]')).click();
  await sleep(500);
  await (await mg.$('.mg-right .mg-op[data-i="2"][data-action="apply"]')).click();
  await sleep(500);
  check((await status()) === 'No changes, No conflicts', 'all changes processed');
  // A manual edit in the result.
  const last = await mg.$('.mg-result .cm-line:has-text("h from other")');
  await last.click();
  await mg.press('.mg-result .cm-content', 'End');
  await mg.type('.mg-result .cm-content', ' // reviewed');
  await sleep(500);
  await shot('merge-window-resolved');
  await (await mg.$('button:has-text("Apply Changes")')).click();
  await sleep(2500);
  const expected = 'a\nb from master\nb from other\nc\nd from master\ne\nf\ng\nh from other // reviewed\n';
  check(file('src/conflict.ts') === expected, `conflict.ts merged: ${JSON.stringify(file('src/conflict.ts'))}`);

  // third.ts opens next: magic resolve of the simple conflict.
  mg = await findFrame(window, '.mg-root', 'let x');
  await sleep(1500);
  await shot('merge-magic');
  await (await mg.$('.mg-result .mg-op[data-action="resolve"]')).click();
  await sleep(500);
  check((await status()) === 'No changes, No conflicts', 'magic resolved third.ts');
  await (await mg.$('button:has-text("Apply Changes")')).click();
  await sleep(2500);
  check(file('src/third.ts') === 'let x = 10 + 20;\n', 'third.ts merged by magic resolve');

  dlg = await findFrame(window, '.dialog', 'Conflicts');
  await sleep(500);
  check((await dlg.textContent('.conflicts-description')).includes('All conflicts have been resolved'), 'dialog says "All conflicts have been resolved"');
  await shot('conflicts-dialog-done');
  check(unmerged().length === 3, 'nothing is marked resolved before Accept and Finish');
  await (await dlg.$('button:has-text("Accept and Finish")')).click();
  await sleep(3000);
  check(unmerged().length === 0, 'Accept and Finish marked every file resolved');
  check(sh(workspace, 'git diff --cached --name-only').includes('src/conflict.ts'), 'conflict.ts staged');
  console.log('E2E CONFLICTS OK');
}
