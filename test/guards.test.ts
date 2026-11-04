import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { asksForDelete, asksForMerge, checkBash, checkWritePath } from '../src/agent/guards.js';

const noMerge = { mergeAllowed: false, deleteAllowed: false };
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
  assert.equal(allowed('gh pr merge 12 --squash', { mergeAllowed: true, deleteAllowed: false }), true);
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

test('charlie never approves: plan approve/reject, migrate switch and --auto-switch are denied', () => {
  const anything = { mergeAllowed: true, deleteAllowed: true };
  assert.equal(allowed('charlie plan approve pln_1 --revision 2', anything), false);
  assert.equal(allowed('charlie plan reject pln_1 --comment no', anything), false);
  assert.equal(allowed('charlie --json plan approve pln_1', anything), false);
  assert.equal(allowed('charlie --server https://api.hopcharlie.dev plan approve pln_1', anything), false);
  assert.equal(allowed('/data/tools/go/bin/charlie migrate switch run_1', anything), false);
  assert.equal(allowed('XDG_CONFIG_HOME=/tmp/x charlie migrate switch run_1', anything), false);
  assert.equal(allowed('charlie plan list && charlie plan approve pln_1', anything), false);
  assert.equal(allowed('charlie migrate start pln_1 --auto-switch --watch', anything), false);
  assert.equal(allowed('charlie migrate start pln_1 --canary 10,50 --watch'), true);
  assert.equal(allowed('charlie plan show pln_1'), true);
  assert.equal(allowed('charlie migrate watch run_1'), true);
});

test('charlie app rm and app branch rm need an explicit deletion request', () => {
  assert.equal(allowed('charlie app rm moimroom --yes'), false);
  assert.equal(allowed('charlie app branch rm moimroom feature/x --yes'), false);
  assert.equal(allowed('charlie app rm moimroom --yes', { mergeAllowed: false, deleteAllowed: true }), true);
  assert.equal(allowed('charlie app branch rm moimroom moimroom--x --yes', { mergeAllowed: false, deleteAllowed: true }), true);
  assert.equal(allowed('charlie app list'), true);
  assert.equal(allowed('charlie app branch add moimroom feature/x'), true);
  assert.equal(allowed('charlie deploy moimroom --watch'), true);
  assert.equal(allowed('charlie login --no-wait'), true);
  assert.equal(asksForDelete('moimroom--x 인스턴스 지워줘'), true);
  assert.equal(asksForDelete('앱 삭제해 줘'), true);
  assert.equal(asksForDelete('please remove the app'), true);
  assert.equal(asksForDelete('moimroom 다시 배포해 줘'), false);
});

test('mentioning a tool name inside another command is fine', () => {
  assert.equal(allowed('grep -rn terraform docs/'), true);
  assert.equal(allowed('aws ec2 describe-instances --region ap-northeast-2'), true);
  assert.equal(allowed('git log --oneline -5'), true);
});

test('file tools do not edit the shared clones under repos/, only worktrees', () => {
  const ws = path.resolve('/data/workspace');
  assert.equal(checkWritePath(path.join(ws, 'repos/platform/README.md'), ws).allow, false);
  assert.equal(checkWritePath('repos/platform/README.md', ws).allow, false);
  assert.equal(checkWritePath(path.join(ws, 'worktrees/platform-ab12/README.md'), ws).allow, true);
  assert.equal(checkWritePath(path.join(ws, 'memory/MEMORY.md'), ws).allow, true);
  assert.equal(checkWritePath(path.join(ws, 'repos-notes.md'), ws).allow, true);
});
