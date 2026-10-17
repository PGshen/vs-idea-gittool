import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Repository } from '../src/git/repository';
import {
  buildTodo,
  checkout,
  dropCommits,
  fixupInto,
  interactiveRebase,
  loadRebaseCommits,
  parseOverwrittenFiles,
  parsePushPorcelain,
  push,
  pushSuccessMessage,
  rewordCommit,
  smartOperation,
  squashCommits,
  updateRepository,
  validateNewBranch,
} from '../src/features/ops/engine';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function sh(cwd: string, cmd: string) {
  return execSync(cmd, { cwd, env, stdio: 'pipe' }).toString();
}
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rebased-ops-test-'));
}
function makeRepo(commits = ['a', 'b', 'c', 'd']) {
  const dir = tmp();
  sh(dir, 'git init -q -b master && git config user.name t && git config user.email t@t && git config commit.gpgsign false');
  for (const c of commits) sh(dir, `echo ${c} > ${c}.txt && git add -A && git commit -qm "commit ${c}"`);
  return dir;
}
async function open(dir: string) {
  const top = sh(dir, 'git rev-parse --absolute-git-dir').trim();
  const repo = new Repository(dir, top, top);
  await repo.refresh();
  return repo;
}
const subjects = (dir: string) => sh(dir, 'git log --format=%s').trim().split('\n');
const hashOf = (dir: string, subject: string) => sh(dir, `git log --format=%H --grep="^${subject}$"`).trim();

test('todo uses exec lines for messages', () => {
  const dir = tmp();
  const todo = buildTodo(
    [
      { hash: 'a', subject: 'A', action: 'pick' },
      { hash: 'b', subject: 'B', action: 'reword', message: 'new B' },
      { hash: 'c', subject: 'C', action: 'squash' },
      { hash: 'd', subject: 'D', action: 'fixup', message: 'C+D' },
      { hash: 'e', subject: 'E', action: 'drop' },
    ],
    dir,
  );
  const lines = todo.trim().split('\n');
  // b starts a squash group, so the message is applied once, after the group.
  assert.deepEqual(lines.slice(0, 4), ['pick a A', 'pick b B', 'fixup c C', 'fixup d D']);
  assert.match(lines[4], /^exec git commit --amend/);
  assert.equal(lines[5], 'drop e E');
  assert.equal(lines.length, 6);
});

test('reword HEAD and an older commit', async () => {
  const dir = makeRepo();
  const repo = await open(dir);
  let r = await rewordCommit(repo, hashOf(dir, 'commit d'), 'commit D!');
  assert.equal(r.kind, 'success', r.output);
  r = await rewordCommit(repo, hashOf(dir, 'commit b'), 'commit B!\n\nbody');
  assert.equal(r.kind, 'success', r.output);
  assert.deepEqual(subjects(dir), ['commit D!', 'commit c', 'commit B!', 'commit a']);
  assert.match(sh(dir, 'git log -1 --format=%B HEAD~2'), /body/);
});

test('drop and squash commits', async () => {
  const dir = makeRepo(['a', 'b', 'c', 'd', 'e']);
  const repo = await open(dir);
  let r = await dropCommits(repo, [hashOf(dir, 'commit c')]);
  assert.equal(r.kind, 'success', r.output);
  assert.deepEqual(subjects(dir), ['commit e', 'commit d', 'commit b', 'commit a']);
  r = await squashCommits(repo, [hashOf(dir, 'commit b'), hashOf(dir, 'commit e')], 'b and e');
  assert.equal(r.kind, 'success', r.output);
  assert.deepEqual(subjects(dir), ['commit d', 'b and e', 'commit a']);
  assert.ok(fs.existsSync(path.join(dir, 'e.txt')));
});

test('reword and drop keep merge commits (--rebase-merges)', async () => {
  const dir = makeRepo(['a', 'b']);
  sh(dir, 'git checkout -qb side && echo s > s.txt && git add -A && git commit -qm "commit s" && git checkout -q master');
  sh(dir, 'echo c > c.txt && git add -A && git commit -qm "commit c" && git merge -q --no-ff side -m "merge side" && echo d > d.txt && git add -A && git commit -qm "commit d"');
  const repo = await open(dir);
  let r = await rewordCommit(repo, hashOf(dir, 'commit b'), 'commit B!');
  assert.equal(r.kind, 'success', r.output);
  r = await dropCommits(repo, [hashOf(dir, 'commit c')]);
  assert.equal(r.kind, 'success', r.output);
  const log = subjects(dir);
  assert.ok(log.includes('merge side'), log.join(','));
  assert.ok(log.includes('commit B!'));
  assert.ok(!log.includes('commit c'));
  assert.equal(sh(dir, 'git rev-list --merges --count HEAD').trim(), '1');
});

test('drop the root commit', async () => {
  const dir = makeRepo(['a', 'b']);
  const repo = await open(dir);
  const r = await dropCommits(repo, [hashOf(dir, 'commit a')]);
  assert.equal(r.kind, 'success', r.output);
  assert.deepEqual(subjects(dir), ['commit b']);
});

test('interactive rebase with edit stops', async () => {
  const dir = makeRepo();
  const repo = await open(dir);
  const base = hashOf(dir, 'commit a');
  const commits = await loadRebaseCommits(repo, base);
  const r = await interactiveRebase(
    repo,
    base,
    commits.map(c => ({ hash: c.hash, subject: c.subject, action: c.subject === 'commit c' ? 'edit' : 'pick' })),
  );
  assert.equal(r.kind, 'stopped', r.output);
  sh(dir, 'git rebase --continue');
});

test('fixup into an older commit', async () => {
  const dir = makeRepo();
  const repo = await open(dir);
  sh(dir, 'echo fix >> b.txt && git add b.txt');
  const r = await fixupInto(repo, hashOf(dir, 'commit b'), false);
  assert.equal(r.kind, 'success', r.output);
  assert.deepEqual(subjects(dir), ['commit d', 'commit c', 'commit b', 'commit a']);
  assert.match(sh(dir, 'git show HEAD~2:b.txt'), /fix/);
});

test('push to a bare remote, rejected push, update by rebase', async () => {
  const bare = tmp();
  sh(bare, 'git init -q --bare -b master');
  const a = makeRepo(['a']);
  sh(a, `git remote add origin ${bare} && git push -q -u origin master`);
  const b = tmp();
  sh(b, `git clone -q ${bare} . && git config user.name t && git config user.email t@t`);
  sh(b, 'echo x > x.txt && git add -A && git commit -qm "from b" && git push -q');
  sh(a, 'echo y > y.txt && git add -A && git commit -qm "from a"');
  const repo = await open(a);
  const res = await push(repo, { remote: 'origin', source: 'master', target: 'master' });
  assert.equal(res.ok, false);
  assert.equal(res.rejected, true);
  assert.equal(res.needsUpdate, true);
  const up = await updateRepository(repo, 'rebase');
  assert.equal(up.outcome.kind, 'success', up.outcome.output);
  assert.equal(up.commits, 1);
  assert.equal(up.files, 1);
  const res2 = await push(repo, { remote: 'origin', source: 'master', target: 'master' });
  assert.equal(res2.ok, true, res2.output);
  assert.deepEqual(subjects(a), ['from a', 'from b', 'commit a']);
  const res3 = await push(repo, { remote: 'origin', source: 'master', target: 'feature' });
  assert.equal(res3.refs[0].flag, '*');
});

test('update via merge keeps local changes', async () => {
  const bare = tmp();
  sh(bare, 'git init -q --bare -b master');
  const a = makeRepo(['a']);
  sh(a, `git remote add origin ${bare} && git push -q -u origin master`);
  const b = tmp();
  sh(b, `git clone -q ${bare} . && echo x > x.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm "from b" && git push -q`);
  sh(a, 'echo y > y.txt && git add -A && git commit -qm "from a" && echo dirty >> a.txt');
  const repo = await open(a);
  const up = await updateRepository(repo, 'merge');
  assert.equal(up.outcome.kind, 'success', up.outcome.output);
  assert.match(sh(a, 'git log -1 --format=%s'), /^Merge/);
  assert.match(fs.readFileSync(path.join(a, 'a.txt'), 'utf8'), /dirty/, 'local changes survive (autostash)');
});

test('checkout with local changes and smart checkout', async () => {
  const dir = makeRepo(['a']);
  sh(dir, 'git checkout -qb other && echo other > a.txt && git commit -qam other && git checkout -q master && echo local > a.txt');
  const repo = await open(dir);
  const r = await checkout(repo, 'other');
  assert.equal(r.kind, 'localChanges');
  if (r.kind === 'localChanges') assert.deepEqual(r.files, ['a.txt']);
  const s = await smartOperation(repo, () => checkout(repo, 'other'), 'checkout');
  assert.equal(s.kind, 'conflicts', 'unstash conflicts with the checked out branch');
});

test('parsers and validators', async () => {
  assert.deepEqual(parsePushPorcelain('To /tmp/x\n!\trefs/heads/master:refs/heads/master\t[rejected] (fetch first)\nDone\n')[0].flag, '!');
  assert.deepEqual(parseOverwrittenFiles('error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\n\tb/c.txt\nPlease commit')!.files, ['a.txt', 'b/c.txt']);
  assert.equal(pushSuccessMessage({ remote: 'origin', source: 'master', target: 'master' }, 1, false, false), 'Pushed 1 commit to origin/master');
  assert.equal(pushSuccessMessage({ remote: 'origin', source: 'master', target: 'master' }, 3, false, false), 'Pushed 3 commits to origin/master');
  const dir = makeRepo(['a']);
  sh(dir, 'git branch feature/x');
  const repo = await open(dir);
  assert.equal(validateNewBranch(repo, 'master', false), 'Branch name master already exists');
  assert.equal(validateNewBranch(repo, 'master', true), undefined);
  assert.match(validateNewBranch(repo, 'feature', false)!, /directory/);
  assert.match(validateNewBranch(repo, 'a..b', false)!, /not valid/);
  assert.equal(validateNewBranch(repo, 'HEAD', false), 'HEAD is a reserved keyword');
});
