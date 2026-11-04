import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { asksForMerge, asksToDelete, checkBash, checkWritePath, type BashContext } from '../src/agent/guards.js';

const noMerge: BashContext = { mergeAllowed: false, request: '', scheduled: false };
const allowed = (cmd: string, ctx = noMerge) => checkBash(cmd, ctx).allow;
/** A request that asks for everything: merge, and deletion of the names used in these tests. */
const anything: BashContext = { mergeAllowed: true, request: 'moimroom 삭제하고 머지해 줘', scheduled: false };
const scheduled: BashContext = { mergeAllowed: false, request: '', scheduled: true };
const asking = (request: string): BashContext => ({ mergeAllowed: false, request, scheduled: false });
/** A backslash-newline line continuation. */
const NL = '\\\n';

test('git push only to rin/ branches', () => {
  assert.equal(allowed('git push origin rin/fix-typo'), true);
  assert.equal(allowed('git push -u origin rin/fix-typo'), true);
  assert.equal(allowed('git push origin HEAD:rin/fix-typo'), true);
  assert.equal(allowed('git -C worktrees/platform-ab12 push origin rin/ab12'), true);
  assert.equal(allowed(`git push origin ${NL}  rin/x`), true);
  assert.equal(allowed('git push origin main'), false);
  assert.equal(allowed('git push origin HEAD:main'), false);
  assert.equal(allowed('git push origin rin/x:refs/heads/master'), false);
  assert.equal(allowed('git push'), false);
  assert.equal(allowed('git push origin'), false);
  assert.equal(allowed('cd repo && git push origin main'), false);
  assert.equal(allowed(`git push origin ${NL}  main`), false);
  assert.equal(allowed('timeout 60 git push origin main'), false);
});

test('force push is always denied', () => {
  assert.equal(allowed('git push --force origin rin/x'), false);
  assert.equal(allowed('git push -f origin rin/x'), false);
  assert.equal(allowed('git push --force-with-lease origin rin/x'), false);
  assert.equal(allowed('git push origin +rin/x'), false);
});

test('merge needs an explicit request', () => {
  assert.equal(allowed('gh pr merge 12 --squash'), false);
  assert.equal(allowed('gh pr merge 12 --squash', { ...noMerge, mergeAllowed: true }), true);
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
  assert.equal(allowed('timeout 30 kubectl get pods'), false);
});

test('charlie never approves: plan approve/reject, migrate switch and rollback are always denied', () => {
  assert.equal(allowed('charlie plan approve pln_1 --revision 2', anything), false);
  assert.equal(allowed('charlie plan reject pln_1 --comment no', anything), false);
  assert.equal(allowed('charlie --json plan approve pln_1', anything), false);
  assert.equal(allowed('charlie --server https://api.hopcharlie.dev plan approve pln_1', anything), false);
  assert.equal(allowed('charlie plan --server https://api.hopcharlie.dev approve pln_1', anything), false);
  assert.equal(allowed('charlie plan --comment ok approve pln_1', anything), false);
  assert.equal(allowed('/data/tools/go/bin/charlie migrate switch run_1', anything), false);
  assert.equal(allowed('"$GOPATH/bin/charlie" migrate switch run_1', anything), false);
  assert.equal(allowed('CHARLIE_CONFIG_DIR=/tmp/x charlie migrate switch run_1', anything), false);
  assert.equal(allowed('charlie plan list && charlie plan approve pln_1', anything), false);
  // rollback stores the reverse plan approved in the token owner's name and switches by default.
  assert.equal(allowed('charlie migrate rollback run_1', anything), false);
  assert.equal(allowed('charlie migrate rollback run_1 --auto-switch=false --reason x', anything), false);
});

test('charlie: --auto-switch and --auto-rollback are denied, --auto-switch=false is fine', () => {
  assert.equal(allowed('charlie migrate start pln_1 --auto-switch --watch', anything), false);
  assert.equal(allowed('charlie migrate start pln_1 --auto-switch=true', anything), false);
  assert.equal(allowed('charlie migrate start pln_1 --observe 2m --auto-rollback', anything), false);
  assert.equal(allowed(`charlie migrate start pln_1 ${NL}  --auto-switch`, anything), false);
  assert.equal(allowed('charlie migrate start pln_1 --auto-switch=false --watch'), true);
  assert.equal(allowed('charlie migrate start pln_1 --observe 2m --auto-rollback=false'), true);
  assert.equal(allowed('charlie migrate start pln_1 --canary 10,50 --watch'), true);
  assert.equal(allowed('charlie plan show pln_1'), true);
  assert.equal(allowed('charlie migrate watch run_1'), true);
  assert.equal(allowed('charlie migrate abort run_1 --reason "switch failed"'), true);
});

test('charlie: help runs nothing, so it is allowed on any command', () => {
  assert.equal(allowed('charlie migrate rollback --help'), true);
  assert.equal(allowed('charlie plan approve -h'), true);
  assert.equal(allowed('charlie migrate start pln_1 --help --auto-switch'), true);
  assert.equal(allowed('charlie help plan approve'), true);
  assert.equal(allowed('charlie app rm --help', scheduled), true);
  // Here --help is the value of --comment, and the approval would run.
  assert.equal(allowed('charlie plan approve pln_1 --comment --help', anything), false);
  assert.equal(allowed('charlie plan approve pln_1 --help; charlie plan approve pln_1', anything), false);
});

test('charlie guard sees through continuations, loops, wrappers, background jobs and subshells', () => {
  const denied = [
    'for p in a b; do charlie plan approve $p; done',
    'while read r; do charlie migrate switch $r; done < runs.txt',
    'if charlie whoami; then charlie migrate switch run_1; fi',
    'charlie whoami || charlie plan approve x',
    '! charlie plan approve x',
    'timeout 600 charlie plan approve x',
    'timeout -s KILL 10m charlie plan approve x',
    'nohup charlie migrate switch run_1 &',
    'nohup charlie migrate switch run_1 > /tmp/log 2>&1 &',
    'sudo -E charlie plan approve x',
    'sudo -u node charlie plan approve x',
    'env charlie plan approve x',
    'env -i HOME=/tmp FOO="a b" charlie plan approve x',
    'time charlie plan approve x',
    'nice -n 5 charlie plan approve x',
    'exec charlie plan approve x',
    'command charlie plan approve x',
    'mise exec -- charlie plan approve x',
    'mise exec go@1.26 -- go run ./cmd/charlie plan approve x',
    'echo pln_1 | xargs -n1 charlie plan approve',
    'echo pln_1 | xargs -I {} charlie plan approve {}',
    'bash -c "charlie plan approve x"',
    "sh -c 'cd repos/cli && charlie migrate rollback run_1'",
    'bash -lc "for p in a; do charlie plan approve $p; done"',
    'eval "charlie plan approve x"',
    'cd repos/cli && go run ./cmd/charlie plan approve pln_1',
    'go run ./cmd/charlie/ plan approve pln_1',
    'go run -C repos/cli ./cmd/charlie plan approve pln_1',
    'go run github.com/2026-Softbank-Hackathon-Charlie/cli/cmd/charlie@latest plan approve pln_1',
    'sleep 1 & charlie plan approve x',
    '(charlie plan approve x)',
    '(cd repos/cli; charlie plan approve x)',
    '{ charlie plan approve x; }',
    '$(charlie plan approve x)',
    'out=$(charlie plan approve x)',
    'out="$(charlie plan approve x)"',
    'export OUT=`charlie plan approve x`',
    '`charlie plan approve x`',
  ];
  for (const cmd of denied) assert.equal(allowed(cmd, anything), false, cmd);
});

test('charlie mentioned outside command position is fine', () => {
  assert.equal(allowed('grep -rn "charlie plan approve" README.md'), true);
  assert.equal(allowed('rg -n "charlie migrate (switch|rollback)" repos/cli'), true);
  assert.equal(allowed('cat docs/charlie.md'), true);
  assert.equal(allowed('ls /data/tools/go/bin/charlie'), true);
  assert.equal(allowed('which charlie'), true);
  assert.equal(allowed('go test ./cmd/charlie ./internal/cli'), true);
  assert.equal(allowed('git log --oneline --grep "migrate rollback"'), true);
  assert.equal(allowed('curl -s "https://api.hopcharlie.dev/healthz?a=1&b=2"'), true);
  assert.equal(allowed('charlie plan show pln_1 2>&1 | head -20'), true);
  assert.equal(allowed('charlie deploy logs dep_1 &> /tmp/deploy.log'), true);
});

test('charlie app rm and app branch rm need a request that asks to delete that target', () => {
  // No request, or a deletion word without the target name.
  assert.equal(allowed('charlie app rm moimroom --yes'), false);
  assert.equal(allowed('charlie app branch rm moimroom dev --yes'), false);
  assert.equal(allowed('charlie app rm moimroom --yes', asking('이 함수 제거하는 PR 만들어 줘')), false);
  assert.equal(allowed('charlie app branch rm moimroom moimroom--dev --yes', asking('인스턴스 없애 줘')), false);
  // The target named, but no deletion asked for.
  assert.equal(allowed('charlie app rm moimroom --yes', asking('moimroom 다시 배포해 줘')), false);
  // The request names a longer name; the command would delete the whole app.
  assert.equal(allowed('charlie app rm moimroom --yes', asking('moimroom--dev 인스턴스 지워 줘')), false);
  assert.equal(allowed('charlie app branch rm moimroom', asking('moimroom 지워 줘')), false);
  // Deletion word and target in the same request.
  assert.equal(allowed('charlie app rm moimroom --yes', asking('moimroom 앱 삭제해 줘')), true);
  assert.equal(allowed('charlie app rm moimroom --yes', asking('MoimRoom 등록을 지워 줘')), true);
  assert.equal(allowed('charlie --server X app rm moimroom --yes', asking('please delete moimroom')), true);
  assert.equal(allowed('charlie app branch rm moimroom moimroom--dev --yes', asking('`moimroom--dev` 인스턴스 없애 줘')), true);
  assert.equal(allowed('charlie app branch rm moimroom feature/x --yes', asking('feature/x 브랜치 인스턴스 remove 해 줘')), true);
  assert.equal(asksToDelete('moimroom 삭제', 'moimroom'), true);
  assert.equal(asksToDelete('moimroom-v2 삭제', 'moimroom'), false);
  assert.equal(asksToDelete('moimroom 삭제', 'moim.room'), false);
});

test('charlie in a scheduled run only reads', () => {
  const changes = [
    'charlie login',
    'charlie login --no-wait',
    'charlie logout',
    'charlie app add --repo o/moimroom --env eks',
    'charlie app rm moimroom --yes',
    'charlie app branch add moimroom dev',
    'charlie app branch rm moimroom dev --yes',
    'charlie app validate --remote --repo o/moimroom',
    'charlie deploy moimroom --watch',
    'charlie deploy --branch dev moimroom',
    'charlie plan new --app moimroom --from gke --to eks',
    'charlie plan new --app moimroom --from gke --to eks --submit',
    'charlie plan submit -f plan.json',
    'charlie plan attach pln_1 --name cnpg -f c.yaml',
    'charlie plan approve pln_1',
    'charlie migrate start pln_1 --watch',
    'charlie migrate abort run_1',
    'charlie migrate resume run_1',
    'charlie migrate rollback run_1',
    'charlie migrate switch run_1',
  ];
  for (const cmd of changes) assert.equal(allowed(cmd, scheduled), false, cmd);
  const reads = [
    'charlie whoami',
    'charlie env list',
    'charlie app list',
    'charlie app show moimroom',
    'charlie app branch list moimroom',
    'charlie app validate -f platform.yaml',
    'charlie app repos',
    'charlie deploy list moimroom --limit 5',
    'charlie deploy show dep_1',
    'charlie deploy watch dep_1',
    'charlie deploy logs dep_1',
    'charlie plan list',
    'charlie plan show pln_1',
    'charlie migrate list',
    'charlie migrate status run_1',
    'charlie migrate watch run_1',
    'charlie audit --limit 20',
    'charlie traffic',
    'charlie security --severity high',
  ];
  for (const cmd of reads) assert.equal(allowed(cmd, scheduled), true, cmd);
  // The same changes are fine in a Slack request (deletion aside, which needs its own request).
  assert.equal(allowed('charlie login --no-wait'), true);
  assert.equal(allowed('charlie deploy moimroom --watch'), true);
  assert.equal(allowed('charlie app branch add moimroom dev'), true);
  assert.equal(allowed('charlie plan new --app moimroom --from gke --to eks --submit'), true);
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
