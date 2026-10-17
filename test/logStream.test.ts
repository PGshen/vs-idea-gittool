import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogStream, parseDecorations } from '../src/git/logStream';

test('parses decorations', () => {
  assert.deepEqual(parseDecorations('HEAD -> refs/heads/master, tag: refs/tags/v1, refs/remotes/origin/master'), [
    'HEAD',
    'refs/heads/master',
    'refs/tags/v1',
    'refs/remotes/origin/master',
  ]);
});

test('streams this repository log in pages', async () => {
  const s = new LogStream(process.cwd(), ['HEAD']);
  const first = await s.next(1);
  assert.equal(first.commits.length, 1);
  assert.match(first.commits[0].hash, /^[0-9a-f]{40}$/);
  const rest = await s.next(1000);
  assert.equal(rest.done, true);
  s.dispose();
});
