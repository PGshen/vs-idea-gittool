// E2E: a merge with conflicts in two files. The Conflicts dialog opens IntelliJ's three-pane merge
// window ("Resolve Manually…"): apply non-conflicting changes, both sides of the conflict, Apply Changes.
// The second file is resolved with "Accept Left".
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const sh = (cwd, cmd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();

async function findFrame(window, selector, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of window.frames()) if (await f.$(selector).catch(() => null)) return f;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`frame with ${selector} not found`);
}

async function openMergeFor(window, sleep, file) {
  const dlg = await findFrame(window, '.dialog');
  await (await dlg.$(`text=${file}`)).click();
  await sleep(300);
  await (await dlg.$('button:has-text("Resolve Manually")')).click();
  return findFrame(window, '.mg-root');
}

export async function run({ window, shot, command, sleep, workspace }) {
  sh(workspace, 'git stash -u -q');
  const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', ''].join('\n');
  writeFileSync(`${workspace}/src/conflict.ts`, base);
  writeFileSync(`${workspace}/src/second.ts`, 'one\ntwo\n');
  sh(workspace, 'git add -A && git commit -qm "base for conflicts"');
  sh(workspace, 'git checkout -q -b other');
  writeFileSync(`${workspace}/src/conflict.ts`, base.replace('b\n', 'b from other\n').replace('g\n', 'g\nh from other\n'));
  writeFileSync(`${workspace}/src/second.ts`, 'one\ntwo from other\n');
  sh(workspace, 'git commit -qam "other change"');
  sh(workspace, 'git checkout -q master');
  writeFileSync(`${workspace}/src/conflict.ts`, base.replace('b\n', 'b from master\n').replace('d\n', 'd from master\n'));
  writeFileSync(`${workspace}/src/second.ts`, 'one\ntwo from master\n');
  sh(workspace, 'git commit -qam "master change"');
  sh(workspace, 'git merge other || true');
  await sleep(4000);
  await command('Rebased: Resolve Conflicts');
  await sleep(2500);
  await shot('conflicts-dialog');

  let mg = await openMergeFor(window, sleep, 'src/conflict.ts');
  await sleep(1500);
  await shot('merge-window');
  const status = async () => (await mg.textContent('.mg-status')).trim();
  console.log('STATUS', await status());
  // Apply all non-conflicting changes (d from master, h from other).
  await (await mg.$('button.mg-text-action:has-text("All")')).click();
  await sleep(400);
  // The conflict: apply left, then append right.
  await (await mg.$('button[data-action="apply"][data-side="left"]')).click();
  await sleep(400);
  await (await mg.$('button[data-action="apply"][data-side="right"]')).click();
  await sleep(600);
  console.log('STATUS', await status());
  await shot('merge-window-resolved');
  await (await mg.$('button:has-text("Apply Changes")')).click();
  await sleep(2500);
  const content = sh(workspace, 'cat src/conflict.ts');
  console.log('RESULT', JSON.stringify(content));
  const expected = 'a\nb from master\nb from other\nc\nd from master\ne\nf\ng\nh from other\n';
  if (content !== expected) throw new Error(`unexpected result, expected ${JSON.stringify(expected)}`);
  if (sh(workspace, 'git diff --name-only --diff-filter=U').trim() !== 'src/second.ts') throw new Error('conflict.ts not marked resolved');
  console.log('OK: conflict.ts merged and resolved');

  mg = await openMergeFor(window, sleep, 'src/second.ts');
  await sleep(1200);
  await (await mg.$('button:has-text("Accept Left")')).click();
  await sleep(2500);
  await shot('merge-all-resolved');
  if (sh(workspace, 'git diff --name-only --diff-filter=U').trim() !== '') throw new Error('second.ts not resolved');
  if (sh(workspace, 'cat src/second.ts') !== 'one\ntwo from master\n') throw new Error('Accept Left did not keep yours');
  console.log('E2E CONFLICTS OK');
}
