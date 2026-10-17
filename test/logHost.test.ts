import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { parseBlamePorcelain } from '../src/features/log/annotate';
import { parseNameStatus } from '../src/features/log/details';
import { parseDate, remoteWebUrl } from '../src/features/log/logTab';

test('remote URLs map to web URLs', () => {
  assert.equal(remoteWebUrl('git@github.com:detachhead/rebased.git'), 'https://github.com/detachhead/rebased');
  assert.equal(remoteWebUrl('https://github.com/detachhead/rebased.git'), 'https://github.com/detachhead/rebased');
  assert.equal(remoteWebUrl('ssh://git@gitlab.com/a/b.git'), 'https://gitlab.com/a/b');
  assert.equal(remoteWebUrl('/local/path'), undefined);
});

test('parses dates for the Date filter', () => {
  assert.equal(parseDate('2026-06-01'), Date.parse('2026-06-01') / 1000);
  const rel = parseDate('3 days ago')!;
  assert.ok(Math.abs(Date.now() / 1000 - 3 * 86400 - rel) < 5);
  assert.equal(parseDate('nonsense'), undefined);
});

test('parses name-status with renames', () => {
  const c = parseNameStatus('/r', 'M\0a.txt\0R100\0old.txt\0new.txt\0D\0gone.txt\0');
  assert.deepEqual(c, [
    { root: '/r', path: 'a.txt', status: 'M' },
    { root: '/r', path: 'new.txt', oldPath: 'old.txt', status: 'R' },
    { root: '/r', path: 'gone.txt', status: 'D' },
  ]);
});

test('parses git blame --porcelain of this repository', () => {
  const out = execSync('git blame --porcelain HEAD -- package.json', { encoding: 'utf8' });
  const r = parseBlamePorcelain(out);
  const lines = execSync('git show HEAD:package.json', { encoding: 'utf8' }).split('\n').length - 1;
  assert.equal(r.lines.length, lines);
  assert.ok(r.lines.every(l => l && l.author && l.authorTime > 0 && l.summary));
});
