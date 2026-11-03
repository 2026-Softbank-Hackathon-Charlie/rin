import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROMPT_FILES, systemAppend } from '../src/agent/options.js';

test('every prompt file is appended in order', () => {
  const prompt = systemAppend();
  const titles = ['# Rin', '# 해커톤 문맥', '# 한국어 글쓰기', '# 코드 작업 지침', '# 말투와 캐릭터'];
  assert.equal(titles.length, PROMPT_FILES.length);
  let from = 0;
  for (const title of titles) {
    const at = prompt.indexOf(`${title}\n`, from);
    assert.ok(at >= from, `${title} is missing or out of order`);
    from = at + title.length;
  }
});
