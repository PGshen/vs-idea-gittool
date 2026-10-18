import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineText } from '../src/features/log/inlineBlame';

const c = { author: 'pengguishen', authorTime: Date.UTC(2026, 3, 21, 10, 42) / 1000, summary: 'feat: implement session-based prompts' };

test('inline blame text: author, date, time • subject', () => {
  const text = inlineText(c, 'zh-CN');
  assert.match(text, /^pengguishen, 2026\/4\/21, \d\d:42 • feat: implement session-based prompts$/);
});

test('inline blame text follows the display language', () => {
  assert.match(inlineText(c, 'en-US'), /^pengguishen, 4\/21\/2026, \d\d:42 • feat:/);
});
