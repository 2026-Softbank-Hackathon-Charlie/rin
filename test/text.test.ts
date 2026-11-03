import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, modelLabel, splitMessage, tail } from '../src/slack/text.js';

test('short text stays in one chunk', () => {
  assert.deepEqual(splitMessage('hello\nworld', 100), ['hello\nworld']);
});

test('chunks respect the limit and keep every line', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
  const chunks = splitMessage(lines.join('\n'), 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
  assert.equal(chunks.join('\n'), lines.join('\n'));
});

test('a code block cut by a split is closed and reopened', () => {
  const body = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join('\n');
  const text = `intro\n\`\`\`ts\n${body}\n\`\`\`\noutro`;
  const chunks = splitMessage(text, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
    const fences = c.split('\n').filter((l) => l.trim().startsWith('```')).length;
    assert.equal(fences % 2, 0, `unbalanced fences in chunk:\n${c}`);
  }
  assert.ok(chunks[1]!.startsWith('```ts'));
});

test('a line longer than the limit is cut hard', () => {
  const chunks = splitMessage('a'.repeat(450), 200);
  assert.deepEqual(chunks.map((c) => c.length), [200, 200, 50]);
});

test('the limit counts UTF-8 bytes, so Korean answers stay under Slack 4,000 bytes', () => {
  // A 3,148-character Korean answer (5,942 bytes) was rejected by chat.update as msg_too_long.
  const lines = Array.from({ length: 60 }, (_, i) => `${i}. 플랫폼 배포에 필요한 설정을 정리했습니다 ${'가'.repeat(40)}`);
  const chunks = splitMessage(lines.join('\n'));
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(Buffer.byteLength(c) <= 3900, `chunk too long: ${Buffer.byteLength(c)} bytes`);
  assert.equal(chunks.join('\n'), lines.join('\n'));
});

test('a hard cut never splits a character', () => {
  const chunks = splitMessage('가'.repeat(150) + '😀'.repeat(10), 200);
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c) <= 200);
    assert.doesNotMatch(c, /�|[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
  }
  assert.equal(chunks.join(''), '가'.repeat(150) + '😀'.repeat(10));
});

test('tail keeps the end and starts on a line boundary', () => {
  assert.equal(tail('abc', 10), 'abc');
  assert.equal(tail('first line\nsecond line\nthird', 15), 'third');
});

test('durations read naturally', () => {
  assert.equal(formatDuration(5_000), '5초');
  assert.equal(formatDuration(135_000), '2분 15초');
  assert.equal(formatDuration(3_780_000), '1시간 3분');
});

test('model ids become readable names with the effort', () => {
  assert.equal(modelLabel('claude-opus-5-5', 'xhigh'), 'Opus 5.5 (XHigh)');
  assert.equal(modelLabel('claude-sonnet-5-5', 'high'), 'Sonnet 5.5 (High)');
  assert.equal(modelLabel('claude-opus-5', 'max'), 'Opus 5 (Max)');
  assert.equal(modelLabel('claude-haiku-4-5-20251001', 'medium'), 'Haiku 4.5 (Medium)');
  assert.equal(modelLabel('claude-opus-4-20250514', 'low'), 'Opus 4 (Low)');
  assert.equal(modelLabel('claude-3-5-sonnet-20241022', 'high'), 'claude-3-5-sonnet-20241022 (High)');
});
