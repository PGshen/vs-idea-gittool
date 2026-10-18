import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Repository } from '../src/git/repository';
import { createPatch } from '../src/features/commit/gitOps';
import { rebasePatchPaths, reversePatch } from '../src/features/commit/patchDialog';
import { revertableResolvedFiles } from '../src/features/commit/view';

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ideagittool-gaps-test-')));
  execSync('git init -q -b master && git config user.name t && git config user.email t@e.st', { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'old\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  return { dir, repo: new Repository(dir, path.join(dir, '.git'), path.join(dir, '.git')) };
}

test('reverse patch undoes the change; rebased paths apply from the base directory', async () => {
  const { dir, repo } = makeRepo();
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'one\nTWO\nthree\nfour\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  fs.rmSync(path.join(dir, 'old.txt'));
  await repo.refresh();
  const changes = [...repo.status.changes, ...repo.status.unversioned];
  const { patch } = await createPatch(repo, changes);
  // git diff -R produces a reversed patch too.
  const gitReverse = (await createPatch(repo, changes, { reverse: true })).patch;
  assert.match(gitReverse, /^-TWO$/m);

  // The reversed text patch brings the work tree back to HEAD.
  const reversed = reversePatch(patch);
  fs.writeFileSync(path.join(dir, '..', 'rev.patch'), reversed);
  execSync(`git apply ../rev.patch`, { cwd: dir });
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.txt'), 'utf8'), 'one\ntwo\nthree\n');
  assert.ok(!fs.existsSync(path.join(dir, 'new.txt')));
  assert.equal(fs.readFileSync(path.join(dir, 'old.txt'), 'utf8'), 'old\n');

  // Paths relative to the parent directory: apply with the repository folder as prefix.
  const parent = path.dirname(dir);
  const rebased = rebasePatchPaths(patch, dir, parent);
  const name = path.basename(dir);
  assert.match(rebased, new RegExp(`^diff --git a/${name}/src/a.txt b/${name}/src/a.txt$`, 'm'));
  assert.match(rebased, new RegExp(`^\\+\\+\\+ b/${name}/new.txt$`, 'm'));
  fs.writeFileSync(path.join(parent, `${name}.patch`), rebased);
  execSync(`git apply ${name}.patch`, { cwd: parent });
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.txt'), 'utf8'), 'one\nTWO\nthree\nfour\n');
});

test('revert resolved brings the conflict back', async () => {
  const { dir, repo } = makeRepo();
  execSync('git checkout -qb other && echo theirs > old.txt && git commit -qam theirs && git checkout -q master && echo ours > old.txt && git commit -qam ours', { cwd: dir });
  execSync('git merge other || true', { cwd: dir, stdio: 'ignore' });
  await repo.refresh();
  assert.equal(repo.status.conflicts.length, 1);
  assert.deepEqual(await revertableResolvedFiles(repo), [], 'unresolved files are not "resolved"');
  fs.writeFileSync(path.join(dir, 'old.txt'), 'resolved\n');
  execSync('git add old.txt', { cwd: dir });
  await repo.refresh();
  assert.equal(repo.status.conflicts.length, 0);
  assert.deepEqual(await revertableResolvedFiles(repo), ['old.txt']);
  await repo.exec(['checkout', '-m', '--', 'old.txt']);
  await repo.refresh();
  assert.equal(repo.status.conflicts.length, 1, 'conflict restored');
  assert.match(fs.readFileSync(path.join(dir, 'old.txt'), 'utf8'), /<<<<<<< ours/);
});
