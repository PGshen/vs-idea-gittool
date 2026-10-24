import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../src/git/repository';
import { addCommitsToRemoteBranch, dropSelectedChanges, extractSelectedChanges, undoEdit } from '../src/features/log/inMemory';

const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' };

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ideagittool-inmem-'));
  const sh = (c: string) => execSync(c, { cwd: dir, env, encoding: 'utf8' });
  // The code under test commits with its own environment, so the identity must be in the repository config.
  sh('git init -q -b main && git config user.name a && git config user.email a@x');
  writeFileSync(join(dir, 'a.txt'), 'a1\n');
  writeFileSync(join(dir, 'b.txt'), 'b1\n');
  sh('git add -A && git commit -qm base');
  writeFileSync(join(dir, 'a.txt'), 'a2\n');
  writeFileSync(join(dir, 'b.txt'), 'b2\n');
  writeFileSync(join(dir, 'c.txt'), 'c2\n');
  sh('git add -A && git commit -qm "change a b c"');
  writeFileSync(join(dir, 'd.txt'), 'd3\n');
  sh('git add -A && git commit -qm "add d"');
  return { dir, sh };
}

async function open(dir: string) {
  const repo = new Repository(dir, join(dir, '.git'), join(dir, '.git'));
  await repo.refresh();
  return repo;
}

test('drop selected changes rewrites the commit and its descendants and updates the files', async () => {
  const { dir, sh } = makeRepo();
  writeFileSync(join(dir, 'local.txt'), 'untracked\n');
  const repo = await open(dir);
  const target = sh('git rev-parse HEAD~1').trim();
  const r = await dropSelectedChanges(repo, target, [{ path: 'b.txt' }, { path: 'c.txt' }]);
  assert.equal(sh('git log --format=%s').trim().split('\n').join('|'), 'add d|change a b c|base');
  assert.equal(sh('git show --name-only --format= HEAD~1').trim(), 'a.txt');
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'b1\n');
  assert.equal(existsSync(join(dir, 'c.txt')), false);
  assert.equal(readFileSync(join(dir, 'local.txt'), 'utf8'), 'untracked\n');
  await repo.refresh();
  await undoEdit(repo, r, 'drop selected changes');
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'b2\n');
  repo.dispose();
});

test('extract selected changes splits a commit without changing the final tree', async () => {
  const { dir, sh } = makeRepo();
  const repo = await open(dir);
  const treeBefore = sh('git rev-parse "HEAD^{tree}"').trim();
  const target = sh('git rev-parse HEAD~1').trim();
  const r = await extractSelectedChanges(repo, target, [{ path: 'c.txt' }], 'add c');
  assert.equal(sh('git rev-parse "HEAD^{tree}"').trim(), treeBefore);
  assert.equal(sh('git log --format=%s').trim().split('\n').join('|'), 'add d|add c|change a b c|base');
  assert.equal(sh('git show --name-only --format= HEAD~1').trim(), 'c.txt');
  assert.equal(sh('git show --name-only --format= HEAD~2').trim().split('\n').join(','), 'a.txt,b.txt');
  assert.equal(sh(`git log -1 --format=%s ${r.focus}`).trim(), 'add c');
  assert.equal(sh('git status --porcelain').trim(), '');
  repo.dispose();
});

test('add commits to a remote branch cherry-picks in memory', async () => {
  const { dir, sh } = makeRepo();
  const bare = mkdtempSync(join(tmpdir(), 'ideagittool-inmem-bare-'));
  execSync('git init -q --bare -b main', { cwd: bare });
  sh(`git remote add origin ${bare} && git push -q origin HEAD~2:refs/heads/release`);
  const repo = await open(dir);
  const hash = sh('git rev-parse HEAD').trim();
  const tip = await addCommitsToRemoteBranch(repo, [hash], 'origin', 'release');
  assert.ok(tip);
  assert.equal(sh(`git log -1 --format=%s ${tip}`).trim(), 'add d');
  assert.equal(sh(`git show --name-only --format= ${tip}`).trim(), 'd.txt');
  // Already present: nothing to add.
  sh(`git push -q origin ${tip}:refs/heads/release`);
  assert.equal(await addCommitsToRemoteBranch(repo, [hash], 'origin', 'release'), null);
  repo.dispose();
});
