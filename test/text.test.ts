import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, splitMessage, tail } from '../src/slack/text.js';

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

test('tail keeps the end and starts on a line boundary', () => {
  assert.equal(tail('abc', 10), 'abc');
  assert.equal(tail('first line\nsecond line\nthird', 15), 'third');
});

test('durations read naturally', () => {
  assert.equal(formatDuration(5_000), '5초');
  assert.equal(formatDuration(135_000), '2분 15초');
  assert.equal(formatDuration(3_780_000), '1시간 3분');
});
