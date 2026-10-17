import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMergeChunks, rangeText, resolveSimple, sideKind, statusText, unprocessedMessage } from '../src/shared/mergeModel';

const L = (s: string) => (s ? s.split(',') : []);

test('non-conflicting changes on each side', () => {
  const base = L('a,b,c,d,e');
  const left = L('a,B,c,d,e');
  const right = L('a,b,c,d,E,f');
  const ch = buildMergeChunks(base, left, right);
  assert.deepEqual(ch.map(c => c.type), ['left', 'right']);
  assert.deepEqual(ch[0], { base: [1, 2], left: [1, 2], right: [1, 2], type: 'left' });
  assert.deepEqual(ch[1].base, [4, 5]);
  assert.deepEqual(ch[1].right, [4, 6]);
  assert.equal(sideKind(ch[0], 'left'), 'modified');
  assert.equal(sideKind(ch[0], 'right'), 'none');
});

test('conflict when both sides change the same lines', () => {
  const ch = buildMergeChunks(L('a,b,c'), L('a,X,c'), L('a,Y,c'));
  assert.equal(ch.length, 1);
  assert.equal(ch[0].type, 'conflict');
  assert.deepEqual(ch[0].left, [1, 2]);
  assert.equal(ch[0].resolved, undefined);
});

test('identical change on both sides is not a conflict', () => {
  const ch = buildMergeChunks(L('a,b,c'), L('a,X,c'), L('a,X,c'));
  assert.deepEqual(ch.map(c => c.type), ['both']);
});

test('touching changes are a conflict that magic resolve can merge', () => {
  const base = L('a,b,c,d');
  const left = L('a,B,c,d');
  const right = L('a,b,C,d');
  const ch = buildMergeChunks(base, left, right);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].type, 'conflict');
  assert.deepEqual(ch[0].resolved, ['B', 'C']);
  assert.deepEqual(ch[0].base, [1, 3]);
});

test('add/add conflict with empty base', () => {
  const ch = buildMergeChunks([], L('a,from master,c'), L('a,from other,c'));
  assert.equal(ch.length, 1);
  assert.equal(ch[0].type, 'conflict');
  assert.deepEqual(ch[0].left, [0, 3]);
  assert.deepEqual(ch[0].right, [0, 3]);
  assert.equal(sideKind(ch[0], 'left'), 'conflict');
});

test('ranges stay correct after earlier insertions and deletions', () => {
  const base = L('1,2,3,4,5,6,7,8');
  const left = L('0,1,2,3,4,5,6,7,8'); // insertion at top
  const right = L('1,2,4,5,6,7,X'); // deletion of 3, change of 8
  const ch = buildMergeChunks(base, left, right);
  assert.deepEqual(ch.map(c => c.type), ['left', 'right', 'right']);
  const last = ch[2];
  assert.deepEqual(last.base, [7, 8]);
  assert.deepEqual(last.left, [8, 9]);
  assert.deepEqual(last.right, [6, 7]);
  assert.equal(rangeText(right, last.right), 'X\n');
  assert.equal(sideKind(ch[1], 'right'), 'deleted');
  assert.equal(sideKind(ch[0], 'left'), 'inserted');
});

test('applying all chunks from left reproduces left', () => {
  const base = L('a,b,c,d,e,f,g');
  const left = L('a,b2,c,e,f,g,h');
  const right = L('a,b,c,d,e,F,g');
  const ch = buildMergeChunks(base, left, right);
  // Replace each chunk base range with the left content, from the end.
  const out = base.slice();
  for (const c of [...ch].reverse()) out.splice(c.base[0], c.base[1] - c.base[0], ...left.slice(c.left[0], c.left[1]));
  assert.deepEqual(out, left);
  const outR = base.slice();
  for (const c of [...ch].reverse()) outR.splice(c.base[0], c.base[1] - c.base[0], ...right.slice(c.right[0], c.right[1]));
  assert.deepEqual(outR, right);
});

test('resolveSimple refuses intersecting changes and same insertion point', () => {
  assert.equal(resolveSimple(L('a'), L('x'), L('y')), undefined);
  assert.equal(resolveSimple([], L('x'), L('y')), undefined);
  assert.deepEqual(resolveSimple(L('a,b'), L('a2,b'), L('a,b2')), ['a2', 'b2']);
});

test('IntelliJ status texts', () => {
  assert.equal(statusText({ changes: 2, conflicts: 1 }), '2 changes, 1 conflict');
  assert.equal(statusText({ changes: 0, conflicts: 0 }), 'No changes, No conflicts');
  assert.equal(unprocessedMessage({ changes: 2, conflicts: 1 }), 'There are 2 changes and one conflict left unprocessed.\nSave changes and mark the conflict resolved anyway?');
  assert.equal(unprocessedMessage({ changes: 0, conflicts: 1 }), 'There is one conflict left unprocessed.\nSave changes and mark the conflict resolved anyway?');
});
