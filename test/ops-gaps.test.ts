import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Repository } from '../src/git/repository';
import {
  ChangesSaver,
  createWorktree,
  listWorktrees,
  OperationOutcome,
  parseWorktreeList,
  removeWorktree,
  resetToRemoteBranch,
  StashSaver,
  updateForcePushedBranch,
  updateRepository,
  worktreeOfBranch,
} from '../src/features/ops/engine';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd, env, stdio: 'pipe' }).toString();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rebased-ops-gaps-'));
const subjects = (dir: string) => sh(dir, 'git log --format=%s').trim().split('\n');

async function open(dir: string) {
  const gitDir = sh(dir, 'git rev-parse --absolute-git-dir').trim();
  const common = path.resolve(dir, sh(dir, 'git rev-parse --git-common-dir').trim());
  const repo = new Repository(dir, gitDir, common);
  await repo.refresh();
  return repo;
}

/** A bare remote, clone `a` (tracking origin/master) and clone `b` to make remote changes. */
function remoteSetup() {
  const bare = tmp();
  sh(bare, 'git init -q --bare -b master');
  const a = tmp();
  sh(a, 'git init -q -b master && git config user.name t && git config user.email t@t && git config commit.gpgsign false');
  sh(a, `echo base > base.txt && echo shared > shared.txt && git add -A && git commit -qm base && git remote add origin ${bare} && git push -q -u origin master`);
  const b = tmp();
  sh(b, `git clone -q ${bare} . && git config user.name t && git config user.email t@t`);
  return { bare, a, b };
}

test('update with an explicit stash saves and restores local changes', async () => {
  const { a, b } = remoteSetup();
  sh(b, 'echo remote > remote.txt && git add -A && git commit -qm remote && git push -q');
  sh(a, 'echo local >> base.txt');
  const repo = await open(a);
  const saver = new StashSaver();
  const up = await updateRepository(repo, 'rebase', { saver });
  assert.equal(up.outcome.kind, 'success', up.outcome.output);
  assert.equal(up.restore?.kind, 'success');
  assert.equal(up.savedChangesKept, false);
  assert.match(fs.readFileSync(path.join(a, 'base.txt'), 'utf8'), /local/);
  assert.equal(sh(a, 'git stash list').trim(), '', 'the stash entry is dropped');
  assert.deepEqual(subjects(a), ['remote', 'base']);
});

test('update reports conflicts when restoring the stash', async () => {
  const { a, b } = remoteSetup();
  sh(b, 'echo theirs > shared.txt && git commit -qam theirs && git push -q');
  sh(a, 'echo mine > shared.txt');
  const repo = await open(a);
  const up = await updateRepository(repo, 'merge', { saver: new StashSaver() });
  assert.equal(up.outcome.kind, 'success', up.outcome.output);
  assert.equal(up.restore?.kind, 'conflicts');
  assert.match(sh(a, 'git stash list'), /Uncommitted changes before update/, 'the stash is kept when it could not be applied cleanly');
});

test('a custom saver (shelf) is used instead of --autostash', async () => {
  const { a, b } = remoteSetup();
  sh(b, 'echo remote > remote.txt && git add -A && git commit -qm remote && git push -q');
  sh(a, 'echo local >> base.txt');
  const repo = await open(a);
  const calls: string[] = [];
  let patch = '';
  const saver: ChangesSaver = {
    method: 'shelve',
    async save(r) {
      calls.push('save');
      patch = (await r.execText(['diff', 'HEAD'])) as string;
      await r.exec(['checkout', '--', '.']);
      return true;
    },
    async restore(r): Promise<OperationOutcome> {
      calls.push('restore');
      await r.exec(['apply'], { input: patch });
      return { kind: 'success', output: '' };
    },
  };
  const up = await updateRepository(repo, 'rebase', { saver });
  assert.equal(up.outcome.kind, 'success', up.outcome.output);
  assert.deepEqual(calls, ['save', 'restore']);
  assert.match(fs.readFileSync(path.join(a, 'base.txt'), 'utf8'), /local/);
});

test('force-pushed tracked branch is detected and updated by cherry-picking local commits', async () => {
  const { a, b } = remoteSetup();
  sh(b, 'echo one > one.txt && git add -A && git commit -qm one && git push -q');
  sh(a, 'git pull -q --no-rebase');
  const c = tmp();
  sh(c, `git clone -q ${path.join(b, '.git')} . && git remote set-url origin ${sh(b, 'git remote get-url origin').trim()} && git fetch -q`);
  // b rewrites history: amend "one" and force-push.
  sh(b, 'echo one-amended > one.txt && git commit -qa --amend -m "one (amended)" && git push -q --force');
  sh(a, 'echo mine > mine.txt && git add -A && git commit -qm mine');
  const probe = await updateRepository(await open(c), 'merge');
  assert.ok(probe.forcePushed, 'force push detected on fetch');
  const r = await updateForcePushedBranch(await open(a));
  assert.equal(r.result, 'success', JSON.stringify(r));
  assert.deepEqual(subjects(a), ['mine', 'one (amended)', 'base']);
  assert.equal(sh(a, 'git branch --list "master-*"').trim(), '', 'the backup branch is deleted');
});

test('reset to the remote branch drops local commits', async () => {
  const { a, b } = remoteSetup();
  sh(b, 'echo r > r.txt && git add -A && git commit -qm remote && git push -q');
  sh(a, 'echo l > l.txt && git add -A && git commit -qm local');
  const repo = await open(a);
  const r = await resetToRemoteBranch(repo);
  assert.equal(r.outcome.kind, 'success', r.outcome.output);
  assert.deepEqual(subjects(a), ['remote', 'base']);
  assert.equal(sh(a, 'git rev-parse --abbrev-ref @{upstream}').trim(), 'origin/master');
});

test('worktrees: parse, create, find by branch, remove', async () => {
  const parsed = parseWorktreeList(
    'worktree /r\nHEAD 1111\nbranch refs/heads/master\n\nworktree /r-wt\nHEAD 2222\nbranch refs/heads/feature\nlocked busy\n\nworktree /gone\nHEAD 3333\ndetached\nprunable gitdir file points to non-existent location\n\n',
  );
  assert.equal(parsed.length, 3);
  assert.deepEqual(
    parsed.map(w => [w.main, w.branch, w.locked, w.lockReason, w.detached, w.prunable]),
    [
      [true, 'master', false, undefined, false, false],
      [false, 'feature', true, 'busy', false, false],
      [false, undefined, false, undefined, true, true],
    ],
  );
  const { a } = remoteSetup();
  sh(a, 'git branch feature');
  const repo = await open(a);
  const target = path.join(tmp(), 'wt-feature');
  const c = await createWorktree(repo, { path: target, ref: 'feature' });
  assert.equal(c.kind, 'success', c.output);
  assert.equal((await worktreeOfBranch(repo, 'feature'))?.path, fs.realpathSync(target));
  const c2 = await createWorktree(repo, { path: path.join(tmp(), 'wt-new'), ref: 'master', newBranch: 'topic' });
  assert.equal(c2.kind, 'success', c2.output);
  assert.equal((await listWorktrees(repo)).length, 3);
  fs.writeFileSync(path.join(target, 'dirty.txt'), 'x');
  const r1 = await removeWorktree(repo, target);
  assert.notEqual(r1.kind, 'success', 'untracked files block removal');
  const r2 = await removeWorktree(repo, target, true);
  assert.equal(r2.kind, 'success', r2.output);
  assert.equal((await listWorktrees(repo)).length, 2);
});
