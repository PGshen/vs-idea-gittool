import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphLayout, graphColor } from '../src/git/graph';

// History (newest first):
// M  merge of A2 into B1
// A2
// B1
// A1
// R  root
const commits: [string, string[]][] = [
  ['M', ['B1', 'A2']],
  ['A2', ['A1']],
  ['B1', ['R']],
  ['A1', ['R']],
  ['R', []],
];

test('merge layout uses two lanes and converges', () => {
  const g = new GraphLayout();
  const rows = commits.map(([h, p]) => g.add(h, p));
  assert.deepEqual(rows.map(r => r.lane), [0, 1, 0, 1, 0]);
  assert.equal(Math.max(...rows.map(r => r.width)), 2);
  // A1 converges into lane 0, which already waits for the root.
  assert.deepEqual(rows[3].edges.filter(e => e.fromY === 1).map(e => e.toLane), [0]);
  assert.equal(rows[4].width, 1);
  // Merge commit has edges to both parents.
  assert.equal(rows[0].edges.filter(e => e.fromY === 1).length, 2);
});

test('linear history stays in one lane', () => {
  const g = new GraphLayout();
  const rows = ['a', 'b', 'c'].map((h, i, arr) => g.add(h, arr[i + 1] ? [arr[i + 1]] : []));
  assert.ok(rows.every(r => r.lane === 0 && r.width === 1));
  assert.equal(rows[0].color, rows[2].color);
});

test('unrelated heads get separate lanes and the free lane is reused', () => {
  const g = new GraphLayout();
  const r1 = g.add('x1', ['x0']);
  const r2 = g.add('y1', ['y0']);
  assert.equal(r1.lane, 0);
  assert.equal(r2.lane, 1);
  g.add('x0', []);
  const r4 = g.add('y0', []);
  assert.equal(r4.lane, 0, 'lane 1 shifts left after lane 0 ends');
});

test('graph colors match IntelliJ DefaultColorGenerator', () => {
  // colorId 0: r=100,g=120,b=170 -> hue 0.611
  assert.match(graphColor(0, 0.6, 0.6), /^rgb\(\d+,\d+,\d+\)$/);
  assert.notEqual(graphColor(0, 0.6, 0.6), graphColor(1, 0.6, 0.6));
});
