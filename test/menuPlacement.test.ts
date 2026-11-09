import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submenuPlacement } from '../src/webview/lib/menuPlacement';

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

test('submenu opens flush to the right of the parent, first item level with the row', () => {
  const p = submenuPlacement(200, 150, rect(106, 300, 294, 324), rect(100, 100, 300, 600), 1200, 800);
  assert.deepEqual(p, { left: 299, top: 293 });
});

test('submenu flips to the left side when the right has no room', () => {
  const p = submenuPlacement(200, 150, rect(806, 300, 994, 324), rect(800, 100, 1000, 600), 1100, 800);
  assert.deepEqual(p, { left: 601, top: 293 });
});

test('submenu shifts up to stay in the viewport when it is beside the parent', () => {
  const p = submenuPlacement(200, 300, rect(106, 700, 294, 724), rect(100, 100, 300, 760), 1200, 800);
  assert.equal(p.top, 800 - 4 - 300);
  assert.equal(p.left, 299);
});

test('narrow view: the submenu never covers the hovered row (issue #25)', () => {
  // A side-bar webview 360px wide: neither side of the parent fits the submenu.
  const row = rect(10, 500, 340, 524);
  const below = submenuPlacement(300, 200, row, rect(4, 100, 350, 700), 360, 800);
  assert.equal(below.top, 526);
  const above = submenuPlacement(300, 400, row, rect(4, 100, 350, 700), 360, 800);
  assert.equal(above.top + 400, 498);
  for (const p of [below, above]) assert.ok(p.left >= 4 && p.left + 300 <= 356);
});

test('narrow view: a tall submenu scrolls on the roomier side instead of covering the row', () => {
  const p = submenuPlacement(300, 700, rect(10, 600, 340, 624), rect(4, 100, 350, 700), 360, 800);
  assert.deepEqual(p, { left: 56, top: 4, maxHeight: 594 });
});
