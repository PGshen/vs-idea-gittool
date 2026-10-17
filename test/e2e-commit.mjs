// E2E: open the Commit tool window, include a file, commit it, and check the result with git.
import { execSync } from 'node:child_process';

async function findFrame(window, selector, sleep) {
  for (let i = 0; i < 40; i++) {
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

export async function run({ window, shot, command, sleep, workspace }) {
  await command('Rebased: Commit…');
  await sleep(2500);
  const frame = await findFrame(window, '.tw-tabs', sleep);
  await sleep(1000);
  await shot('commit-view');
  // Include src/file1.ts only.
  const row = await frame.$('.tree-row:has-text("file1.ts") .tree-check');
  await row.click();
  await frame.fill('.message-box textarea', 'e2e commit from Rebased');
  await frame.click('.commit-buttons .btn:has-text("Commit")');
  await sleep(3000);
  await shot('commit-done');
  const log = execSync('git log -1 --format=%s --name-only', { cwd: workspace }).toString();
  console.log('LAST COMMIT:', JSON.stringify(log));
  if (!log.includes('e2e commit from Rebased') || !log.includes('src/file1.ts')) throw new Error('commit not created');
  if (log.includes('README.md')) throw new Error('README.md must not be committed');
  console.log('E2E COMMIT OK');
}
