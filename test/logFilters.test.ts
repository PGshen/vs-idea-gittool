import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_FILTERS, isStructureBroken, logArgs } from '../src/features/log/filters';

test('default log shows all refs in topological order', () => {
  assert.deepEqual(logArgs(EMPTY_FILTERS, { sort: 'topo', firstParent: false }), ['--topo-order', '--branches', '--remotes', '--tags', 'HEAD', '--']);
});

test('text filter is case-insensitive fixed string by default', () => {
  const a = logArgs({ ...EMPTY_FILTERS, text: 'fix (a' }, { sort: 'date', firstParent: false });
  assert.ok(a.includes('--grep=fix (a') && a.includes('-i') && a.includes('--fixed-strings') && a.includes('--date-order'));
  const b = logArgs({ ...EMPTY_FILTERS, text: 'fi.x', regex: true, matchCase: true }, { sort: 'topo', firstParent: false });
  assert.ok(b.includes('-E') && !b.includes('-i'));
});

test('branch, user, date and path filters', () => {
  const a = logArgs({ ...EMPTY_FILTERS, branches: ['master'], users: ['bob'], since: 100, paths: ['src/a.ts'] }, { sort: 'topo', firstParent: true });
  assert.deepEqual(a, ['--topo-order', '--first-parent', '--author=bob', '--since=100', '--parents', 'master', '--', 'src/a.ts']);
  assert.equal(isStructureBroken({ ...EMPTY_FILTERS, users: ['x'] }), true);
  assert.equal(isStructureBroken({ ...EMPTY_FILTERS, paths: ['x'] }), false);
});

test('file history follows renames', () => {
  const a = logArgs({ ...EMPTY_FILTERS, paths: ['a.ts'], follow: true }, { sort: 'date', firstParent: false });
  assert.ok(a.includes('--follow') && !a.includes('--parents'));
});
