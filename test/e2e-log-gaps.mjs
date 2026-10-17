// E2E for the multi-root log, long edges, diff preview, Collapse Linear Branches and in-memory editing.
// Run: node test/e2e-log-gaps.mjs --setup <dir>  (creates two repositories in <dir>), then
//      xvfb-run -a node scripts/e2e.mjs test/e2e-log-gaps.mjs <dir>
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = { ...process.env, GIT_AUTHOR_NAME: 'detachhead', GIT_AUTHOR_EMAIL: 'detachhead@users.noreply.github.com', GIT_COMMITTER_NAME: 'detachhead', GIT_COMMITTER_EMAIL: 'detachhead@users.noreply.github.com' };

function makeRepo(dir, name, count, sideAt) {
  const r = join(dir, name);
  mkdirSync(r, { recursive: true });
  const sh = c => execSync(c, { cwd: r, env, stdio: 'pipe' });
  sh('git init -q -b master');
  for (let i = 0; i < count; i++) {
    writeFileSync(join(r, `f${i}.txt`), `line ${i}\n`);
    sh(`git add -A && git commit -q -m "${name}: change ${i}" --date="2026-06-${String(1 + (i % 27)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00"`);
    if (i === sideAt) {
      sh('git checkout -q -b feature/long');
      writeFileSync(join(r, 'side.txt'), 'side\n');
      sh('git add -A && git commit -q -m "feature: long running branch"');
      sh('git checkout -q master');
    }
  }
}

if (process.argv[2] === '--setup') {
  const dir = process.argv[3];
  makeRepo(dir, 'alpha', 45, 2);
  makeRepo(dir, 'beta', 12, -1);
  console.log(dir);
}

async function frameWith(window, selector) {
  for (const f of window.frames()) if (await f.$(selector).catch(() => null)) return f;
  return undefined;
}

export async function run({ window, shot, sleep }) {
  await sleep(5000);
  const log = await frameWith(window, '.log-table');
  if (!log) throw new Error('log not found');
  await shot('gaps-multiroot');
  const roots = await log.$$eval('.cell.root', els => new Set(els.map(e => e.getAttribute('data-tip'))).size);
  console.log('root strips', roots);
  const arrows = await log.$$eval('.graph-arrow', els => els.length);
  console.log('long edge arrows', arrows);
  // Show the diff preview from the changes browser view options.
  await log.click('.right [data-tip="View Options"]');
  await sleep(300);
  await log.hover('.menu-item >> text=Configure Layout');
  await sleep(300);
  await log.click('.menu-item >> text=Show Diff Preview');
  await sleep(1500);
  await shot('gaps-diff-preview');
  // Collapse linear branches.
  await log.click('[data-tip="Graph Options"]');
  await sleep(300);
  await log.click('.menu-item >> text=Collapse Linear Branches');
  await sleep(2000);
  const rows = await log.$$eval('.log-row', els => els.length);
  console.log('rows after collapse', rows);
  await shot('gaps-collapsed');
}
