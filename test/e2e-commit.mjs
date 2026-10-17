// E2E for the commit feature in real VS Code: commit one file, shelve / unshelve, rollback, stash / unstash
// and the Local History window. Run: xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/e2e.mjs test/e2e-commit.mjs
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

async function findFrame(window, selector, sleep, tries = 40) {
  for (let i = 0; i < tries; i++) {
    for (const f of window.frames()) {
      try {
        if (await f.$(selector)) return f;
      } catch {
        // detached frame
      }
    }
    await sleep(500);
  }
  throw new Error(`frame with ${selector} not found`);
}

/** Runs a command through the command center: works even when a webview has the keyboard focus. */
let paletteShot;
async function palette(window, sleep, title) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await window.keyboard.press('F1');
    await sleep(500);
    if (await window.isVisible('.quick-input-widget .quick-input-box input')) {
      await window.fill('.quick-input-widget .quick-input-box input', '>' + title);
      await sleep(700);
      if (paletteShot) await paletteShot('palette-' + title.replace(/[^a-z]+/gi, '-'));
      // A webview that just loaded may steal the focus and close the palette: retry then.
      if (!(await window.isVisible('.quick-input-widget .quick-input-box input'))) continue;
      await window.keyboard.press('Enter');
      await sleep(1500);
      return;
    }
    // A webview has the focus and swallowed F1: focus the workbench (status bar) and retry.
    await window.click('.part.statusbar', { position: { x: 700, y: 10 } }).catch(() => undefined);
    await sleep(500);
  }
  throw new Error(`cannot open the command palette for ${title}`);
}

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd }).toString();
}

function check(cond, message) {
  if (!cond) throw new Error(message);
  console.log('OK:', message);
}

export async function run({ window, shot, sleep, workspace }) {
  paletteShot = process.env.E2E_DEBUG ? shot : undefined;
  // The Git log opens on startup and takes the focus when it has loaded: wait for it first.
  await findFrame(window, '.log-row', sleep).catch(() => undefined);
  await sleep(2000);
  await palette(window, sleep, 'Rebased: Commit…');
  const frame = await findFrame(window, '.tw-tabs', sleep);
  await sleep(1000);
  await shot('commit-view');

  // 1. Commit only src/file1.ts.
  await frame.click('.tree-row:has-text("file1.ts") .tree-check');
  await frame.fill('.message-box textarea', 'e2e commit from Rebased');
  await frame.click('.commit-buttons .btn:has-text("Commit")');
  await sleep(3000);
  const log = git('log -1 --format=%s --name-only', workspace);
  check(log.includes('e2e commit from Rebased') && log.includes('src/file1.ts') && !log.includes('README.md'), 'commit contains exactly the checked file');

  // 2. Shelve README.md silently, then unshelve it from the Shelf tab.
  await frame.click('.tree-row:visible:has-text("README.md") .label');
  await window.keyboard.press('Control+Shift+H');
  await sleep(3000);
  check(!git('status --porcelain', workspace).includes('README.md'), 'README.md shelved and rolled back');
  await frame.click('.tw-tab:has-text("Shelf")', { force: true });
  await sleep(800);
  await shot('commit-shelf');
  await frame.click('.tree-row:visible >> nth=0', { button: 'right', force: true });
  await sleep(500);
  await frame.click('.menu-item:has-text("Unshelve Silently")', { force: true });
  await sleep(3000);
  check(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8').includes('edit'), 'README.md unshelved');

  // 3. Rollback README.md through the Rollback Changes dialog.
  await frame.click('.tw-tab:has-text("Commit")', { force: true });
  await sleep(800);
  await frame.click('.tree-row:visible:has-text("README.md") .label', { button: 'right', force: true });
  await sleep(500);
  await frame.click('.menu-item:has-text("Rollback…")', { force: true });
  const dialog = await findFrame(window, '.dialog-title:has-text("Rollback Changes")', sleep);
  await shot('commit-rollback-dialog');
  await dialog.click('.dialog-buttons .btn.primary');
  await sleep(2500);
  check(fs.readFileSync(path.join(workspace, 'README.md'), 'utf8') === 'readme\n', 'README.md rolled back');

  // 4. Stash and unstash docs/new.md (staged new file).
  await palette(window, sleep, 'Rebased: Stash Changes…');
  const stash = await findFrame(window, '.dialog-title:has-text("Stash")', sleep);
  await stash.fill('.dialog input.text-field', 'e2e stash');
  await shot('commit-stash-dialog');
  await stash.click('.dialog-buttons .btn.primary');
  await sleep(2500);
  check(git('stash list', workspace).includes('e2e stash'), 'stash created');
  check(!fs.existsSync(path.join(workspace, 'docs', 'new.md')), 'docs/new.md stashed');
  await palette(window, sleep, 'Rebased: Unstash Changes…');
  const unstash = await findFrame(window, '.dialog-title:has-text("Unstash Changes")', sleep);
  await sleep(800);
  await shot('commit-unstash-dialog');
  await unstash.click('.dialog-buttons .btn.primary');
  await sleep(2500);
  check(fs.existsSync(path.join(workspace, 'docs', 'new.md')), 'stash applied');

  // 5. Local History recorded the external changes (rollback, unshelve, stash).
  await palette(window, sleep, 'Rebased: Local History: Show Project History…');
  const lh = await findFrame(window, '.lh-list', sleep);
  await sleep(1500);
  const items = await lh.$$('.lh-item');
  await shot('local-history');
  check(items.length >= 4, `local history shows ${items.length} items (shelve, unshelve, rollback, stash, unstash)`);
  console.log('E2E COMMIT OK');
}
