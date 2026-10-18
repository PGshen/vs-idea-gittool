// E2E: Update Project with "Clean working tree using Shelve": ops saves changes through the commit
// feature's ideagittool.shelveSilently / ideagittool.unshelveSilently, updates by rebase, then restores them.
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const sh = (cwd, cmd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();

export const settings = { 'ideagittool.update.showDialog': false, 'ideagittool.update.saveChangesPolicy': 'shelve', 'ideagittool.updateMethod': 'rebase' };

export async function run({ shot, command, sleep, workspace }) {
  const bare = mkdtempSync(resolve(tmpdir(), 'ideagittool-bare-'));
  sh(bare, 'git init -q --bare -b master');
  sh(workspace, `git remote add origin ${bare} && git push -q -u origin master`);
  const other = mkdtempSync(resolve(tmpdir(), 'ideagittool-other-'));
  sh(other, `git clone -q ${bare} . && git -c user.name=x -c user.email=x@x commit -q --allow-empty -m "incoming from teammate" && git push -q`);
  const before = sh(workspace, 'git status --porcelain');
  await sleep(4000);
  await command('IdeaGitTool: Update Project');
  await sleep(8000);
  await shot('update-shelve');
  const log = sh(workspace, 'git log --format=%s -3');
  const after = sh(workspace, 'git status --porcelain');
  console.log('LOG', JSON.stringify(log));
  console.log('BEFORE', JSON.stringify(before), 'AFTER', JSON.stringify(after));
  if (!log.includes('incoming from teammate')) throw new Error('update did not bring the incoming commit');
  if (before.split('\n').sort().join() !== after.split('\n').sort().join()) throw new Error('local changes not restored');
  if (!readFileSync(resolve(workspace, 'src/file1.ts'), 'utf8').includes('local edit')) throw new Error('edit lost');
  if (!existsSync(resolve(workspace, 'notes.txt'))) throw new Error('untracked file lost');
  console.log('E2E OK');
}
