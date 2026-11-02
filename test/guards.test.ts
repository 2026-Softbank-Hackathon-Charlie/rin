import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { asksForMerge, checkBash, checkWritePath } from '../src/agent/guards.js';

const noMerge = { mergeAllowed: false };
const allowed = (cmd: string, ctx = noMerge) => checkBash(cmd, ctx).allow;

test('git push only to rin/ branches', () => {
  assert.equal(allowed('git push origin rin/fix-typo'), true);
  assert.equal(allowed('git push -u origin rin/fix-typo'), true);
  assert.equal(allowed('git push origin HEAD:rin/fix-typo'), true);
  assert.equal(allowed('git -C worktrees/platform-ab12 push origin rin/ab12'), true);
  assert.equal(allowed('git push origin main'), false);
  assert.equal(allowed('git push origin HEAD:main'), false);
  assert.equal(allowed('git push origin rin/x:refs/heads/master'), false);
  assert.equal(allowed('git push'), false);
  assert.equal(allowed('git push origin'), false);
  assert.equal(allowed('cd repo && git push origin main'), false);
});

test('force push is always denied', () => {
  assert.equal(allowed('git push --force origin rin/x'), false);
  assert.equal(allowed('git push -f origin rin/x'), false);
  assert.equal(allowed('git push --force-with-lease origin rin/x'), false);
  assert.equal(allowed('git push origin +rin/x'), false);
});

test('merge needs an explicit request', () => {
  assert.equal(allowed('gh pr merge 12 --squash'), false);
  assert.equal(allowed('gh pr merge 12 --squash', { mergeAllowed: true }), true);
  assert.equal(allowed('gh api repos/o/r/pulls/12/merge -X PUT'), false);
  assert.equal(asksForMerge('PR 올리고 머지까지 해줘'), true);
  assert.equal(asksForMerge('please merge it'), true);
  assert.equal(asksForMerge('PR만 올려줘'), false);
});

test('destructive and infra commands are denied', () => {
  assert.equal(allowed('gh repo delete o/r --yes'), false);
  assert.equal(allowed('gh api -X DELETE repos/o/r/git/refs/heads/x'), false);
  assert.equal(allowed('gh api --method=DELETE repos/o/r'), false);
  assert.equal(allowed('kubectl get pods'), false);
  assert.equal(allowed('cd infra && terraform apply'), false);
  assert.equal(allowed('sudo helm upgrade x y'), false);
});

test('mentioning a tool name inside another command is fine', () => {
  assert.equal(allowed('grep -rn terraform docs/'), true);
  assert.equal(allowed('aws ec2 describe-instances --region ap-northeast-2'), true);
  assert.equal(allowed('git log --oneline -5'), true);
});

test('repos/ is read-only for file tools', () => {
  const ws = path.resolve('/data/workspace');
  assert.equal(checkWritePath(path.join(ws, 'repos/platform/README.md'), ws).allow, false);
  assert.equal(checkWritePath('repos/platform/README.md', ws).allow, false);
  assert.equal(checkWritePath(path.join(ws, 'worktrees/platform-ab12/README.md'), ws).allow, true);
  assert.equal(checkWritePath(path.join(ws, 'memory/MEMORY.md'), ws).allow, true);
  assert.equal(checkWritePath(path.join(ws, 'repos-notes.md'), ws).allow, true);
});
