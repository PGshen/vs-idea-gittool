import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffPreviewKey } from '../src/webview/commit/diffPreview';
import { changeKey } from '../src/shared/commitProtocol';
import { Change, ChangeStatus } from '../src/shared/types';

const change = (p: string, status: ChangeStatus = 'M'): Change => ({ root: '/repo', path: p, status });
const file = (c: Change) => ({ data: { kind: 'file' as const, change: c } });

test('diff preview follows a single selected file', () => {
  const a = change('a.txt');
  assert.equal(diffPreviewKey([file(a)]), changeKey(a));
  assert.equal(diffPreviewKey([file(change('new.txt', '?'))]), changeKey(change('new.txt', '?')));
  assert.equal(diffPreviewKey([file(change('gone.txt', 'D'))]), changeKey(change('gone.txt', 'D')));
});

test('diff preview ignores folders, changelists, several rows and ignored files', () => {
  assert.equal(diffPreviewKey([]), undefined);
  assert.equal(diffPreviewKey([{ data: { kind: 'changelist' as const, id: 'default' } }]), undefined);
  assert.equal(diffPreviewKey([{ data: { kind: 'dir' as const, dir: 'src' } }]), undefined);
  assert.equal(diffPreviewKey([file(change('a.txt')), file(change('b.txt'))]), undefined);
  assert.equal(diffPreviewKey([file(change('build/out.js', '!'))]), undefined);
  assert.equal(diffPreviewKey([{}]), undefined);
});
