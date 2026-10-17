import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalHistoryStore } from '../src/features/localHistory/store';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lh-test-'));
}

test('records events and resolves file states around them', () => {
  const dir = tmp();
  const s = new LocalHistoryStore(dir);
  const v1 = s.putContent('one\n');
  const v2 = s.putContent('two\n');
  const v3 = s.putContent('three\n');
  const create = s.record({ kind: 'create', path: '/w/a.txt', before: null, after: v1 });
  const label = s.record({ kind: 'label', label: 'Before refactoring' });
  const change = s.record({ kind: 'change', path: '/w/a.txt', before: v1, after: v2 });
  const rename = s.record({ kind: 'rename', oldPath: '/w/a.txt', path: '/w/b.txt', before: v2, after: v2 });
  s.record({ kind: 'change', path: '/w/b.txt', before: v2, after: v3, external: true });

  assert.equal(s.stateBefore('/w/a.txt', create.id), null);
  assert.equal(s.stateBefore('/w/a.txt', label.id), v1);
  assert.equal(s.stateBefore('/w/a.txt', change.id), v1);
  assert.equal(s.stateAfter('/w/a.txt', change.id), v2);
  assert.equal(s.stateBefore('/w/a.txt', rename.id + 1), null, 'a.txt is gone after the rename');
  assert.equal(s.stateBefore('/w/b.txt', label.id), null, 'b.txt did not exist at the label');
  assert.equal(s.latestState('/w/b.txt'), v3);
  assert.deepEqual(s.pathsChangedSince(label.id), ['/w/a.txt', '/w/b.txt']);
  assert.deepEqual(s.pathsChangedSince(label.id, { path: '/w/b.txt', dir: false }), ['/w/b.txt']);
  assert.equal(s.getContent(v3)!.toString(), 'three\n');

  // Reload from disk.
  const s2 = new LocalHistoryStore(dir);
  assert.equal(s2.events.length, 5);
  assert.equal(s2.latestState('/w/b.txt'), v3);
  assert.equal(s2.eventsFor('/w', true).length, 5);
  assert.equal(s2.eventsFor('/w/a.txt').length, 4, 'create, label, change and rename');
});

test('unknown history before the first event uses its "before" state', () => {
  const s = new LocalHistoryStore(tmp());
  const v1 = s.putContent('x');
  const v2 = s.putContent('y');
  const label = s.record({ kind: 'system', label: 'Before Update' });
  s.record({ kind: 'change', path: '/w/c.txt', before: v1, after: v2, external: true });
  assert.equal(s.stateBefore('/w/c.txt', label.id), v1);
  assert.equal(s.stateBefore('/w/never.txt', label.id), undefined);
});

test('purge drops old events and unreferenced content', () => {
  const dir = tmp();
  const s = new LocalHistoryStore(dir);
  const old = s.putContent('old');
  const fresh = s.putContent('fresh');
  s.record({ kind: 'create', path: '/w/o', before: null, after: old, ts: Date.now() - 10 * 86400_000 });
  s.record({ kind: 'create', path: '/w/f', before: null, after: fresh });
  s.purge(5);
  assert.equal(s.events.length, 1);
  assert.equal(s.getContent(old), undefined);
  assert.equal(s.getContent(fresh)!.toString(), 'fresh');
  assert.equal(new LocalHistoryStore(dir).events.length, 1);
});
