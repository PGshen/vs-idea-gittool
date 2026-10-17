import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMergeChanges,
  iterativeUnprocessedMessage,
  joinText,
  MergeModel,
  splitText,
  statusText,
  unprocessedMessage,
  updateRangeOnModification,
} from '../src/shared/mergeModel';

const L = (s: string) => (s ? s.split(',') : []);

test('change kinds follow MergeRangeUtil.getLineMergeType', () => {
  const base = L('a,b,c,d,e,f');
  const left = L('a,B,c,d,e,f,g');
  const right = L('a,b,c,e,f');
  const ch = buildMergeChanges(base, left, right);
  assert.deepEqual(
    ch.map(c => [c.kind, c.leftChange, c.rightChange]),
    [
      ['modified', true, false],
      ['deleted', false, true],
      ['inserted', true, false],
    ],
  );
  assert.deepEqual(ch[0].base, [1, 2]);
  assert.deepEqual(ch[2].left, [6, 7]);
});

test('identical changes and conflicts', () => {
  assert.deepEqual(
    buildMergeChanges(L('a,b,c'), L('a,X,c'), L('a,X,c')).map(c => [c.kind, c.leftChange, c.rightChange]),
    [['modified', true, true]],
  );
  const conflict = buildMergeChanges(L('a,b,c'), L('a,X,c'), L('a,Y,c'));
  assert.equal(conflict[0].kind, 'conflict');
  assert.equal(conflict[0].canResolve, false);
});

test('a conflict of changes in different words of a line can be resolved automatically', () => {
  const model = MergeModel.create(['const x = 1, y = 2;'], ['const x = 10, y = 2;'], ['const x = 1, y = 20;']);
  assert.equal(model.changes[0].kind, 'conflict');
  assert.equal(model.changes[0].canResolve, true);
  assert.ok(model.resolveChangeAutomatically(0, 'base'));
  assert.deepEqual(model.lines, ['const x = 10, y = 20;']);
  assert.deepEqual(model.stats(), { changes: 0, conflicts: 0 });
});

test('apply both sides of a conflict: replace, then append', () => {
  const model = MergeModel.create(L('a,b,c'), L('a,L,c'), L('a,R,c'));
  assert.ok(model.replaceChange(0, 'left', false));
  assert.deepEqual(model.lines, L('a,L,c'));
  assert.equal(model.states[0].resolvedLeft, true);
  assert.equal(model.states[0].oneside, true);
  assert.ok(model.replaceChange(0, 'right', false));
  assert.deepEqual(model.lines, L('a,L,R,c'));
  assert.deepEqual([model.states[0].start, model.states[0].end], [1, 3]);
  assert.deepEqual(model.stats(), { changes: 0, conflicts: 0 });
});

test('ctrl+click accepts one side and resolves the conflict', () => {
  const model = MergeModel.create(L('a,b,c'), L('a,L,c'), L('a,R,c'));
  model.replaceChange(0, 'right', true);
  assert.deepEqual(model.lines, L('a,R,c'));
  assert.deepEqual(model.stats(), { changes: 0, conflicts: 0 });
});

test('ranges of later changes move with the edits', () => {
  const model = MergeModel.create(L('a,b,c,d,e'), L('a,b1,b2,b3,c,d,e'), L('a,b,c,d,E'));
  assert.deepEqual(model.changes.map(c => c.kind), ['modified', 'modified']);
  model.applyNonConflictedChanges('left');
  assert.deepEqual(model.lines, L('a,b1,b2,b3,c,d,e'));
  assert.deepEqual([model.states[1].start, model.states[1].end], [6, 7]);
  model.applyNonConflictedChanges('base');
  assert.deepEqual(model.lines, L('a,b1,b2,b3,c,d,E'));
});

test('user edits: IntelliJ range update rules', () => {
  assert.deepEqual(updateRangeOnModification(5, 8, 1, 2, 2), { start: 7, end: 10, damaged: false });
  assert.deepEqual(updateRangeOnModification(5, 8, 6, 7, 1), { start: 5, end: 9, damaged: false });
  assert.deepEqual(updateRangeOnModification(5, 8, 4, 6, -1), { start: 5, end: 7, damaged: true });
  const model = MergeModel.create(L('a,b,c,d'), L('a,b,c,d'), L('a,x,c'));
  // right: b -> x, d deleted
  assert.deepEqual(model.changes.map(c => c.kind), ['modified', 'deleted']);
  // The user deletes line 3 ("d") by hand: the deleted change becomes resolved.
  model.lines.splice(3, 1);
  model.onUserEdit(2, 4, -1);
  assert.equal(model.states[1].start, model.states[1].end);
  assert.deepEqual(model.stats(), { changes: 1, conflicts: 0 });
});

test('a change edited by hand is no longer applied automatically', () => {
  const model = MergeModel.create(L('a,b,c'), L('a,B,c'), L('a,b,c'));
  model.lines[1] = 'edited';
  model.onUserEdit(1, 2, 0);
  assert.equal(model.isChangeRangeModified(0), true);
  assert.equal(model.hasNonConflictedChanges('base'), false);
});

test('accept a side resets and applies every change of that side', () => {
  const model = MergeModel.create(L('a,b,c,d'), L('a,L,c,d'), L('a,R,c,D'));
  model.replaceChange(0, 'right', true);
  model.acceptRevisionForSide('left');
  assert.deepEqual(model.lines, L('a,L,c,d'));
  assert.deepEqual(model.stats(), { changes: 0, conflicts: 0 });
});

test('document lines keep the final newline and CRLF', () => {
  const t = splitText('a\r\nb\r\n');
  assert.deepEqual(t.lines, ['a', 'b', '']);
  assert.equal(joinText(t.lines, t.crlf), 'a\r\nb\r\n');
  const model = MergeModel.create(splitText('a\nb\nx\n').lines, splitText('a\nB\nx\n').lines, splitText('a\nb\nx\nc\n').lines);
  model.applyNonConflictedChanges('base');
  assert.equal(joinText(model.lines, false), 'a\nB\nx\nc\n');
});

test('IntelliJ status texts', () => {
  assert.equal(statusText({ changes: 2, conflicts: 1 }), '2 changes, 1 conflict');
  assert.equal(statusText({ changes: 0, conflicts: 0 }), 'No changes, No conflicts');
  assert.equal(unprocessedMessage({ changes: 2, conflicts: 1 }), 'There are 2 changes and one conflict left unprocessed.\nSave changes and mark the conflict resolved anyway?');
  assert.equal(iterativeUnprocessedMessage(1, 2), '1 unresolved conflict and 2 unprocessed changes still remain. The file will be saved exactly as shown in the Result pane.');
  assert.equal(iterativeUnprocessedMessage(0, 1), '1 unprocessed change still remains. The file will be saved exactly as shown in the Result pane.');
});
