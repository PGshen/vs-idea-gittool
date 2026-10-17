import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, mapRangeBack, splitLines, unifiedDiff } from '../src/shared/lineDiff';

test('diffLines finds inserted, deleted and modified blocks', () => {
  const a = ['a', 'b', 'c', 'd', 'e'];
  const b = ['a', 'B', 'c', 'e', 'f'];
  assert.deepEqual(diffLines(a, b), [
    { a0: 1, a1: 2, b0: 1, b1: 2 },
    { a0: 3, a1: 4, b0: 3, b1: 3 },
    { a0: 5, a1: 5, b0: 4, b1: 5 },
  ]);
  assert.deepEqual(diffLines(a, a), []);
  assert.deepEqual(diffLines([], ['x']), [{ a0: 0, a1: 0, b0: 0, b1: 1 }]);
});

test('diff of many edits reproduces the target', () => {
  const a = Array.from({ length: 300 }, (_, i) => `line ${i % 37}`);
  const b = a.filter((_, i) => i % 7 !== 0).map((l, i) => (i % 11 === 0 ? l + '!' : l));
  const blocks = diffLines(a, b);
  const out: string[] = [];
  let pa = 0;
  for (const bl of blocks) {
    out.push(...a.slice(pa, bl.a0), ...b.slice(bl.b0, bl.b1));
    pa = bl.a1;
  }
  out.push(...a.slice(pa));
  assert.deepEqual(out, b);
});

test('mapRangeBack follows insertions above the range', () => {
  const a = ['x', 'y', 'z'];
  const b = ['new', 'new2', 'x', 'y', 'z'];
  assert.deepEqual(mapRangeBack(diffLines(a, b), 3, 5), [1, 3]);
});

test('unifiedDiff produces a git-style hunk', () => {
  const d = unifiedDiff('f.txt', 'f.txt', splitLines('a\nb\nc\n'), splitLines('a\nB\nc\n'));
  assert.equal(d, 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
});
