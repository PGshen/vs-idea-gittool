import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Repository } from '../src/git/repository';
import { createPatch } from '../src/features/commit/gitOps';
import {
  anthropicText,
  buildInstructions,
  buildContext,
  chatBody,
  chatEndpoint,
  chatHeaders,
  cleanCommitMessage,
  cleanPartialCommitMessage,
  openaiText,
  sseStream,
  truncateDiff,
} from '../src/features/commit/aiEngine';

function streamOf(...parts: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(typeof p === 'string' ? encoder.encode(p) : p);
      controller.close();
    },
  });
}

async function frames(...parts: Array<string | Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const f of sseStream(streamOf(...parts))) out.push(f);
  return out;
}

test('sseStream parses frames split across chunks, CRLF, comments, event lines and multi-line data', async () => {
  // A frame broken in the middle of its data line, and one broken between frames.
  assert.deepEqual(await frames('data: {"a":', '1}\n', '\ndata: two\r\n\r\n'), ['{"a":1}', 'two']);
  // Comments and event/id lines are ignored; two data lines of one frame are joined with \n.
  assert.deepEqual(await frames(': keep-alive\nevent: message\nid: 7\ndata: l1\ndata: l2\n\n'), ['l1\nl2']);
  // A trailing frame without the closing blank line is still delivered.
  assert.deepEqual(await frames('data: tail\n'), ['tail']);
});

test('sseStream decodes a multi-byte character split across chunks', async () => {
  const text = 'data: {"t":"提交"}\n\n';
  const bytes = new TextEncoder().encode(text);
  const cut = text.indexOf('提') + 1; // Inside the 3-byte character.
  assert.deepEqual(await frames(bytes.slice(0, cut), bytes.slice(cut)), ['{"t":"提交"}']);
});

test('openaiText extracts delta content and reports errors', () => {
  assert.equal(openaiText('{"choices":[{"delta":{"content":"Fix"}}]}'), 'Fix');
  assert.equal(openaiText('{"choices":[{"delta":{"role":"assistant"}}]}'), undefined);
  assert.equal(openaiText('{"choices":[{"delta":{"content":""}}]}'), undefined);
  assert.equal(openaiText('[DONE]'), 'done');
  assert.throws(() => openaiText('{"error":{"message":"bad key"}}'), /bad key/);
});

test('anthropicText extracts text deltas and reports errors', () => {
  assert.equal(anthropicText('{"type":"content_block_delta","delta":{"type":"text_delta","text":"Fix"}}'), 'Fix');
  assert.equal(anthropicText('{"type":"ping"}'), undefined);
  assert.equal(anthropicText('{"type":"message_start","message":{}}'), undefined);
  assert.equal(anthropicText('{"type":"message_stop"}'), 'done');
  assert.throws(() => anthropicText('{"type":"error","error":{"message":"overloaded"}}'), /overloaded/);
});

test('chatEndpoint uses the official endpoint by default and accepts custom bases', () => {
  assert.equal(chatEndpoint({ provider: 'openai', baseUrl: '', model: 'm' }), 'https://api.openai.com/v1/chat/completions');
  assert.equal(chatEndpoint({ provider: 'openai', baseUrl: 'http://localhost:11434/v1/', model: 'm' }), 'http://localhost:11434/v1/chat/completions');
  assert.equal(chatEndpoint({ provider: 'anthropic', baseUrl: '', model: 'm' }), 'https://api.anthropic.com/v1/messages');
  assert.equal(chatEndpoint({ provider: 'anthropic', baseUrl: 'https://gw.example.com', model: 'm' }), 'https://gw.example.com/v1/messages');
});

test('chatHeaders authenticate only with a key; the anthropic version header is always sent', () => {
  const openai = chatHeaders({ provider: 'openai', baseUrl: '', model: 'm', apiKey: 'sk-1' });
  assert.equal(openai.Authorization, 'Bearer sk-1');
  assert.equal('x-api-key' in openai, false);
  const keyless = chatHeaders({ provider: 'openai', baseUrl: '', model: 'm', apiKey: '' });
  assert.equal('Authorization' in keyless, false);
  const anthropic = chatHeaders({ provider: 'anthropic', baseUrl: '', model: 'm', apiKey: 'k' });
  assert.equal(anthropic['anthropic-version'], '2023-06-01');
  assert.equal(anthropic['x-api-key'], 'k');
  for (const h of [openai, keyless, anthropic]) {
    assert.equal(h['Content-Type'], 'application/json');
    assert.equal(h.Accept, 'text/event-stream');
  }
});

test('chatBody puts the system prompt where the provider expects it and always streams', () => {
  const openai = JSON.parse(chatBody({ provider: 'openai', baseUrl: '', model: 'gpt' }, 'SYS', 'USER'));
  assert.equal(openai.stream, true);
  assert.equal('max_tokens' in openai, false);
  assert.deepEqual(openai.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }]);
  const anthropic = JSON.parse(chatBody({ provider: 'anthropic', baseUrl: '', model: 'claude' }, 'SYS', 'USER'));
  assert.equal(anthropic.stream, true);
  assert.equal(anthropic.max_tokens, 1024);
  assert.equal(anthropic.system, 'SYS');
  assert.deepEqual(anthropic.messages, [{ role: 'user', content: 'USER' }]);
});

test('truncateDiff caps at code points and marks the cut', () => {
  assert.deepEqual(truncateDiff('short', 100), { text: 'short', truncated: false });
  assert.deepEqual(truncateDiff('0123456789', 4), { text: '0123\n...[diff truncated]', truncated: true });
  // '提' is 3 bytes: the cap of 2 characters keeps both whole, never half a character.
  assert.deepEqual(truncateDiff('提交消息', 2), { text: '提交\n...[diff truncated]', truncated: true });
  assert.deepEqual(truncateDiff('anything', 0), { text: 'anything', truncated: false });
});

test('cleanCommitMessage strips fences and quoted one-liners', () => {
  assert.equal(cleanCommitMessage('Fix login\n\n- detail'), 'Fix login\n\n- detail');
  assert.equal(cleanCommitMessage('```\nFix login\n```'), 'Fix login');
  assert.equal(cleanCommitMessage('```text\nFix\n```'), 'Fix');
  assert.equal(cleanCommitMessage('~~~\nFix\n~~~'), 'Fix');
  assert.equal(cleanCommitMessage('"Fix login"'), 'Fix login');
  assert.equal(cleanCommitMessage('`Fix login`'), 'Fix login');
  // Quotes of a multi-line answer are content, not wrapping.
  assert.equal(cleanCommitMessage('"Fix\n  detail"'), '"Fix\n  detail"');
  assert.equal(cleanCommitMessage('  Fix\r\n\r\n\r\n\r\nDone  '), 'Fix\n\nDone');
  // A fence in the middle of the answer is content, not wrapping.
  assert.equal(cleanCommitMessage('Fix\n```\ncode\n```'), 'Fix\n```\ncode\n```');
});

test('cleanPartialCommitMessage only strips the opening of a fence while streaming', () => {
  assert.equal(cleanPartialCommitMessage('```\nFix lo'), 'Fix lo');
  assert.equal(cleanPartialCommitMessage('```text\nFix'), 'Fix');
  assert.equal(cleanPartialCommitMessage('  Fix lo'), 'Fix lo');
});

test('buildInstructions fills the language placeholder and lets a custom prompt replace the default', () => {
  const def = buildInstructions(undefined, 'zh-cn');
  assert.match(def, /language: zh-cn/);
  assert.doesNotMatch(def, /\{language\}/);
  assert.equal(buildInstructions('One line: {language} rules.', 'en'), 'One line: en rules.');
  assert.equal(buildContext(['a', '', undefined, false, 'b']), 'a\n\nb');
});

test('createPatch without --binary describes binary files instead of embedding them', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ideagittool-ai-test-')));
  execSync('git init -q -b master && git config user.name t && git config user.email t@e.st', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'text.txt'), 'one\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'text.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 159, 146, 150, 255, 254]));
  const repo = new Repository(dir, path.join(dir, '.git'), path.join(dir, '.git'));
  await repo.refresh();
  const changes = [...repo.status.changes, ...repo.status.unversioned];
  const plain = await createPatch(repo, changes, { binary: false });
  assert.ok(!plain.patch.includes('GIT binary patch'), 'no embedded binary payload');
  assert.match(plain.patch, /Binary files .*bin\.dat.*differ/);
  assert.match(plain.patch, /\+two/);
  assert.deepEqual(plain.files.map(f => f.path).sort(), ['bin.dat', 'text.txt']);
  const embedded = await createPatch(repo, changes);
  assert.ok(embedded.patch.includes('GIT binary patch'), 'the default still embeds binaries');
});
