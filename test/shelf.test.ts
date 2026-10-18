import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Repository } from '../src/git/repository';
import { Shelf } from '../src/features/commit/shelf';
import { ChangeLists } from '../src/features/commit/changelists';
import { changeKey } from '../src/shared/commitProtocol';

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ideagittool-shelf-test-')));
  execSync('git init -q -b master && git config user.name t && git config user.email t@e.st', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  return { dir, repo: new Repository(dir, path.join(dir, '.git'), path.join(dir, '.git')) };
}

test('shelve, partially unshelve, applied files go to Recently Deleted', async () => {
  const { dir, repo } = makeRepo();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ideagittool-shelf-storage-'));
  const shelf = new Shelf({ fsPath: storage } as never);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'B\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
  await repo.refresh();
  const item = await shelf.shelve(repo, [...repo.status.changes, ...repo.status.unversioned], 'my shelf');
  await repo.refresh();
  assert.equal(repo.status.changes.length + repo.status.unversioned.length, 0, 'work tree reverted');
  assert.deepEqual(item.files.map(f => f.path).sort(), ['a.txt', 'b.txt', 'new.txt']);

  await shelf.unshelve(repo, item.id, ['a.txt', 'new.txt'], true);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'A\n');
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'b\n');
  assert.ok(fs.existsSync(path.join(dir, 'new.txt')));
  const list = shelf.list();
  const remaining = list.find(s => s.id === item.id)!;
  assert.deepEqual(remaining.files.map(f => f.path), ['b.txt']);
  assert.ok(list.some(s => s.deleted && s.files.length === 2), 'applied part is in Recently Deleted');

  // Reload from disk keeps the state.
  const again = new Shelf({ fsPath: storage } as never);
  assert.equal(again.list().length, 2);
  await again.unshelve(repo, item.id, undefined, true);
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'B\n');
  assert.ok(again.list().every(s => s.deleted));
  again.cleanDeleted();
  assert.equal(again.list().length, 0);
  repo.dispose();
});

test('changelists keep files when the active list changes', () => {
  const store = new Map<string, unknown>();
  const memento = { get: (k: string) => store.get(k), update: async (k: string, v: unknown) => void store.set(k, v), keys: () => [...store.keys()] };
  const lists = new ChangeLists(memento as never);
  const c1 = { root: '/r', path: 'a', status: 'M' as const };
  const c2 = { root: '/r', path: 'b', status: 'M' as const };
  lists.sync([c1], []);
  const id = lists.add('Feature', '', true);
  const res = lists.sync([c1, c2], []);
  assert.deepEqual(res.find(l => l.name === 'Changes')!.files, [changeKey(c1)]);
  assert.deepEqual(res.find(l => l.name === 'Feature')!.files, [changeKey(c2)]);
  lists.remove(id);
  const after = lists.sync([c1, c2], []);
  assert.equal(after.length, 1);
  assert.equal(after[0].files.length, 2);
});
