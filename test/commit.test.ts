import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Repository } from '../src/git/repository';
import { acceptSide, applyPatch, commitChanges, createPatch, resolveSimpleConflict, rollbackChanges, splitPatch, stashFiles } from '../src/features/commit/gitOps';
import { Change } from '../src/shared/types';

const opts = { amend: false, signOff: false, gpgSign: false, runHooks: true };

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ideagittool-commit-test-')));
  const sh = (c: string) => execSync(c, { cwd: dir, stdio: 'pipe' }).toString();
  sh('git init -q -b master && git config user.name tester && git config user.email t@e.st && git config commit.gpgsign false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  sh('git add -A && git commit -qm init');
  const repo = new Repository(dir, path.join(dir, '.git'), path.join(dir, '.git'));
  return { dir, sh, repo };
}

async function status(repo: Repository) {
  await repo.refresh();
  return repo.status;
}

const find = (list: Change[], p: string) => list.find(c => c.path === p)!;

test('commits only the selected files, including unversioned and deleted ones', async () => {
  const { dir, sh, repo } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a2\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b2\n');
  fs.rmSync(path.join(dir, 'c.txt'));
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  const st = await status(repo);
  const sel = [find(st.changes, 'a.txt'), find(st.changes, 'c.txt'), find(st.unversioned, 'new.txt')];
  await commitChanges(repo, sel, 'my commit\n\nbody', opts);
  assert.equal(sh('git log -1 --format=%B').trim(), 'my commit\n\nbody');
  assert.deepEqual(sh('git show --name-status --format= HEAD').trim().split('\n').sort(), ['A\tnew.txt', 'D\tc.txt', 'M\ta.txt']);
  const st2 = await status(repo);
  assert.deepEqual(st2.changes.map(c => c.path), ['b.txt']);
  repo.dispose();
});

test('amend message only', async () => {
  const { sh, repo } = makeRepo();
  await commitChanges(repo, [], 'reworded', { ...opts, amend: true });
  assert.equal(sh('git log -1 --format=%s').trim(), 'reworded');
  assert.equal(sh('git rev-list --count HEAD').trim(), '1');
  repo.dispose();
});

test('rollback restores modified, deleted and added files', async () => {
  const { dir, sh, repo } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
  fs.rmSync(path.join(dir, 'b.txt'));
  fs.writeFileSync(path.join(dir, 'added.txt'), 'x\n');
  sh('git add added.txt');
  const st = await status(repo);
  await rollbackChanges(repo, st.changes, true);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'a\n');
  assert.ok(fs.existsSync(path.join(dir, 'b.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'added.txt')));
  assert.equal(sh('git status --porcelain').trim(), '');
  repo.dispose();
});

test('shelve patch includes unversioned files and applies back', async () => {
  const { dir, sh, repo } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'shelved\n');
  fs.writeFileSync(path.join(dir, 'u.bin'), Buffer.from([0, 1, 2, 3]));
  const st = await status(repo);
  const sel = [find(st.changes, 'a.txt'), find(st.unversioned, 'u.bin')];
  const { patch, files } = await createPatch(repo, sel);
  assert.equal(files.length, 2);
  assert.ok(files.find(f => f.path === 'u.bin' && f.status === 'A' && f.newBlob));
  assert.equal(sh('git status --porcelain').trim().split('\n').length, 2, 'real index untouched');
  const sections = splitPatch(patch);
  assert.deepEqual([...sections.keys()].sort(), ['a.txt', 'u.bin']);
  await rollbackChanges(repo, sel, true);
  fs.rmSync(path.join(dir, 'u.bin'));
  assert.equal(sh('git status --porcelain').trim(), '');
  await applyPatch(repo, sections.get('a.txt')!, files.filter(f => f.path === 'a.txt'));
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'shelved\n');
  assert.ok(!fs.existsSync(path.join(dir, 'u.bin')));
  await applyPatch(repo, sections.get('u.bin')!, files.filter(f => f.path === 'u.bin'));
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'u.bin'))], [0, 1, 2, 3]);
  assert.match(sh('git status --porcelain'), /^A  u\.bin$/m);
  repo.dispose();
});

test('stash files include untracked', async () => {
  const { dir, sh, repo } = makeRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'stash\n');
  fs.writeFileSync(path.join(dir, 'u.txt'), 'u\n');
  sh('git stash push -u -m test');
  const hash = sh('git rev-parse stash@{0}').trim();
  const files = await stashFiles(repo, hash);
  assert.deepEqual(files.map(f => `${f.status} ${f.path}`).sort(), ['A u.txt', 'M a.txt']);
  repo.dispose();
});

test('accept theirs resolves a conflict', async () => {
  const { dir, sh, repo } = makeRepo();
  sh('git checkout -qb other && echo other > a.txt && git commit -qam other && git checkout -q master && echo mine > a.txt && git commit -qam mine');
  sh('git merge other || true');
  const st = await status(repo);
  assert.equal(st.conflicts.length, 1);
  await acceptSide(repo, st.conflicts, 'theirs');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'other\n');
  const st2 = await status(repo);
  assert.equal(st2.conflicts.length, 0);
  // Commit of the merge commits the whole index.
  await commitChanges(repo, st2.changes, 'merge', opts);
  assert.equal(sh('git log -1 --format=%P').trim().split(' ').length, 2);
  repo.dispose();
});

test('extra commit with file movements keeps rename history', async () => {
  const { dir, sh, repo } = makeRepo();
  sh('git mv a.txt moved.txt');
  fs.writeFileSync(path.join(dir, 'moved.txt'), 'a\nmore\n');
  const st = await status(repo);
  const r = find(st.changes, 'moved.txt');
  assert.equal(r.status, 'R');
  await commitChanges(repo, [r], 'edit moved', { ...opts, extraMoveCommit: true });
  assert.equal(sh('git log --format=%s -2').trim(), 'edit moved\nMove 1 file');
  assert.equal(sh('git show --name-status --format= HEAD~1').trim().replace(/\d+/, ''), 'R\ta.txt\tmoved.txt');
  assert.equal(sh('git status --porcelain').trim(), '');
  repo.dispose();
});

test('resolve simple conflicts merges non-overlapping changes', async () => {
  const { dir, repo } = makeRepo();
  // Build an unmerged index entry by hand: stages 1 (base), 2 (ours), 3 (theirs) without overlapping edits.
  const blob = (s: string) => execSync('git hash-object -w --stdin', { cwd: dir, input: s }).toString().trim();
  const base = blob('1\n2\n3\n4\n5\n6\n');
  const ours = blob('1\n2\n3\n4\n5\nsix\n');
  const theirs = blob('one\n2\n3\n4\n5\n6\n');
  execSync('git update-index --index-info', { cwd: dir, input: `0 ${'0'.repeat(40)}\ta.txt\n100644 ${base} 1\ta.txt\n100644 ${ours} 2\ta.txt\n100644 ${theirs} 3\ta.txt\n` });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'conflict markers\n');
  const st = await status(repo);
  assert.equal(st.conflicts.length, 1);
  assert.equal(await resolveSimpleConflict(repo, st.conflicts[0]), true);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\n2\n3\n4\n5\nsix\n');
  assert.equal((await status(repo)).conflicts.length, 0);
  repo.dispose();
});

