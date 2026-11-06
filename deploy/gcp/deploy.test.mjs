import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const unix = (p) => p.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const source = (path) => readFileSync(join(root, path), 'utf8');
function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'rin-deploy-test-'));
  const bin = join(temp, 'bin');
  const host = join(temp, 'host');
  const run = join(temp, 'run');
  mkdirSync(bin); mkdirSync(host); mkdirSync(run);
  const put = (name, body) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  put('id', 'echo 0');
  put('stat', `case "$1" in
    -c) case "$2" in
      %g) echo 999;;
      %u) echo "\${TEST_OWNER:-0}";;
      %a) if [ -d "$3" ]; then echo "\${TEST_PARENT_MODE:-700}"; else echo "\${TEST_MODE:-600}"; fi;;
      %h) echo 1;;
    esac;;
    *) exit 1;;
  esac`);
  put('aws', `echo aws >> "$TEST_LOG"; [ "\${TEST_SSM_FAIL:-0}" = 0 ] || exit 1; printf '/rin/POSTGRES_PASSWORD\\tssm-canary\\n'`);
  put('sleep', ':');
  put('docker', `echo "$*" >> "$TEST_LOG"
    case "$*" in
      compose*'ps -q '*) echo "new-\${!#}";;
      'inspect -f {{.State.Health.Status}} new-postgres') echo healthy;;
      'inspect -f {{.State.Health.Status}} '*) if [ "\${TEST_FAIL_HEALTH:-0}" = 1 ]; then echo unhealthy; else echo healthy; fi;;
      'ps -a --filter label=com.docker.compose.service=gateway'*) echo 'old-gateway rin-old running';;
      'ps -a --filter label=com.docker.compose.service=worker'*) echo 'old-worker rin-old running';;
      'cp '*':/app/deploy/ec2/deploy.sh '*) cp -- "$TEST_DEPLOY_SCRIPT" "$3";;
      'create '*) echo temporary-payload;;
      'info --format {{.DockerRootDir}}') echo /var/lib/docker;;
      'ps -aq') echo old-worker;;
      'inspect --format {{.Image}} old-worker') echo sha256:live;;
      'image inspect --format {{.Id}} '*current*) echo sha256:live;;
      'image inspect --format {{.Id}} '*previous*) echo sha256:rollback;;
      'image inspect --format {{.Id}} '*) echo sha256:target;;
      'image ls --format '*) printf 'sha256:live registry/hopcharlie/rin\\nsha256:rollback registry/hopcharlie/rin\\nsha256:garbage registry/hopcharlie/rin\\nsha256:database postgres\\n';;
      login*) cat >/dev/null; [ "\${TEST_LOGIN_FAIL:-0}" = 0 ];;
    esac`);
  put('df', `printf 'Avail\\n%s\\n' "\${TEST_AVAILABLE_KB:-12000000}"`);
  const log = join(temp, 'calls'); writeFileSync(log, '');
  const env = { ...process.env, PATH: `${unix(bin)}:/usr/bin:/bin`, TEST_LOG: unix(log), TEST_BIN: unix(bin), TEST_DEPLOY_SCRIPT: unix(join(temp, 'app-deploy.sh')) };
  const transform = (text) => text.replaceAll('/srv/rin', unix(host)).replaceAll('/run/rin.env', `${unix(run)}/rin.env`).replaceAll('/run/rin-deploy.', `${unix(run)}/rin-deploy.`);
  writeFileSync(join(temp, 'app-deploy.sh'), transform(source('deploy/ec2/deploy.sh')));
  return {
    temp, host, run, log,
    exec(path, args = [], extra = {}) {
      if (!existsSync(join(root, path))) return { status: 99, stdout: '', stderr: `missing ${path}` };
      const script = join(temp, 'script.sh'); writeFileSync(script, transform(source(path)).replace('health_timeout=180', 'health_timeout=0'));
      return spawnSync(bash, ['-c', 'export PATH="$TEST_BIN:/usr/bin:/bin"; exec bash "$@"', 'test', unix(script), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 12000, input: extra.TEST_STDIN });
    },
    cleanup() { rmSync(temp, { recursive: true, force: true }); },
    calls() { return readFileSync(log, 'utf8'); },
  };
}
const image = '123.dkr.ecr.ap-northeast-2.amazonaws.com/hopcharlie/rin:1234567890';
function withFixture(fn) { const f = fixture(); try { fn(f); } finally { f.cleanup(); } }
function privateEnv(f) { const dir = join(f.run, 'input'); mkdirSync(dir); const path = join(dir, 'rin.env'); writeFileSync(path, 'POSTGRES_PASSWORD=file-canary\n'); return unix(path); }

test('one-shot env skips AWS and removes the compose env after success', () => withFixture((f) => {
  const r = f.exec('deploy/ec2/deploy.sh', [image], { RIN_ENV_FILE: privateEnv(f) });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(f.calls(), /^aws$/m);
  assert.equal(existsSync(join(f.run, 'rin.env')), false);
  assert.doesNotMatch(r.stdout + r.stderr, /file-canary/);
  assert.match(f.calls(), /kill --signal=SIGTERM old-worker/);
}));
test('AWS SSM fallback still works and cleans the env', () => withFixture((f) => {
  const r = f.exec('deploy/ec2/deploy.sh', [image]);
  assert.equal(r.status, 0, r.stderr); assert.match(f.calls(), /^aws$/m);
  assert.equal(existsSync(join(f.run, 'rin.env')), false);
}));
for (const [name, extra] of [['owner', { TEST_OWNER: '42' }], ['file mode', { TEST_MODE: '644' }], ['parent mode', { TEST_PARENT_MODE: '755' }]]) {
  test(`rejects unsafe secret ${name} before compose starts`, () => withFixture((f) => {
    const r = f.exec('deploy/ec2/deploy.sh', [image], { RIN_ENV_FILE: privateEnv(f), ...extra });
    assert.notEqual(r.status, 0); assert.doesNotMatch(f.calls(), /compose/);
  }));
}
test('rejects a symlink secret before compose starts', { skip: process.platform === 'win32' ? 'NTFS symlink needs Linux verification' : false }, () => withFixture((f) => {
  const target = privateEnv(f), link = join(f.run, 'input', 'link');
  symlinkSync(target, link);
  const r = f.exec('deploy/ec2/deploy.sh', [image], { RIN_ENV_FILE: unix(link) });
  assert.notEqual(r.status, 0); assert.doesNotMatch(f.calls(), /compose/);
}));
test('health failure cleans env and never removes or drains the old service', () => withFixture((f) => {
  const r = f.exec('deploy/ec2/deploy.sh', [image], { RIN_ENV_FILE: privateEnv(f), TEST_FAIL_HEALTH: '1' });
  assert.notEqual(r.status, 0); assert.equal(existsSync(join(f.run, 'rin.env')), false);
  assert.doesNotMatch(f.calls(), /rm -f old-gateway|kill --signal=SIGTERM old-worker/);
  assert.match(f.calls(), /compose -p rin-1234567 .* down/);
}));
test('disk preflight removes only unreferenced Rin images and keeps rollback and data', () => withFixture((f) => {
  writeFileSync(join(f.host, 'current-image'), 'current\n'); writeFileSync(join(f.host, 'previous-image'), 'previous\n');
  const r = f.exec('deploy/gcp/disk-preflight.sh', [image]); assert.equal(r.status, 0, r.stderr);
  assert.match(f.calls(), /image rm sha256:garbage/);
  assert.doesNotMatch(f.calls(), /image rm sha256:(live|rollback|database)|prune|volume/);
}));
test('disk shortage fails before pull or any old-service mutation', () => withFixture((f) => {
  const r = f.exec('deploy/gcp/disk-preflight.sh', [image], { TEST_AVAILABLE_KB: '123' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /space/);
  assert.doesNotMatch(f.calls(), /pull|compose|kill|rm -f|volume/);
}));
test('GCP host refuses to create the bot before restoration is acknowledged', () => withFixture((f) => {
  const r = f.exec('deploy/gcp/receive.sh'); assert.notEqual(r.status, 0);
  assert.match(r.stderr, /migration-ready/); assert.doesNotMatch(f.calls(), /pull|compose|login/);
}));
test('workflow deploys only to GCP without an EC2 fallback', () => {
  const workflow = source('.github/workflows/deploy.yml');
  assert.doesNotMatch(workflow, /RIN_DEPLOY_TARGET|RIN_INSTANCE_ID|Deploy on EC2|ssm send-command/);
  assert.match(workflow, /google-github-actions\/auth@/);
  assert.match(workflow, /RIN_GCP_WORKLOAD_IDENTITY_PROVIDER/);
  assert.match(workflow, /run: bash deploy\/gcp\/send\.sh/);
});

test('GCP deployment session keeps ECR pull and SSM read without upload permissions', () => {
  const workflow = source('.github/workflows/deploy.yml');
  const session = workflow.split('inline-session-policy:')[1]?.split('\n      - ')[0] ?? '';
  const policy = JSON.parse(session.replace(/^\s*>-/, '').trim());
  const actions = policy.Statement.flatMap((statement) => statement.Action);
  assert.deepEqual(actions.toSorted(), [
    'ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetAuthorizationToken',
    'ecr:GetDownloadUrlForLayer', 'kms:Decrypt', 'ssm:GetParametersByPath',
  ].toSorted());
  assert.deepEqual(policy.Statement.find((statement) => statement.Action === 'kms:Decrypt').Condition, {
    StringEquals: { 'kms:ViaService': 'ssm.ap-northeast-2.amazonaws.com' },
    StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': 'arn:aws:ssm:ap-northeast-2:*:parameter/rin/*' },
  });
});

function payload(f) {
  const dir = join(f.temp, 'payload'); mkdirSync(dir);
  writeFileSync(join(dir, 'rin.env'), 'POSTGRES_PASSWORD=payload-canary\n');
  writeFileSync(join(dir, 'ecr-password'), 'pull-token-canary');
  writeFileSync(join(dir, 'image'), '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/hopcharlie/rin:' + 'a'.repeat(40) + '\n');
  const helper = source('deploy/gcp/disk-preflight.sh').replaceAll('/srv/rin', unix(f.host));
  writeFileSync(join(dir, 'disk-preflight.sh'), helper);
  const archive = spawnSync(bash, ['-c', 'tar -cf - -C "$1" rin.env ecr-password image disk-preflight.sh', 'test', unix(dir)]);
  assert.equal(archive.status, 0, archive.stderr?.toString());
  return archive.stdout;
}
for (const failed of [false, true]) {
  test(`GCP transport ${failed ? 'login failure' : 'success'} removes secrets and propagates status`, () => withFixture((f) => {
    writeFileSync(join(f.host, '.migration-ready'), 'verified restoration\n');
    const r = f.exec('deploy/gcp/receive.sh', [], { TEST_STDIN: payload(f), TEST_LOGIN_FAIL: failed ? '1' : '0' });
    assert.equal(r.status, failed ? 1 : 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /payload-canary|pull-token-canary/);
    assert.equal(existsSync(join(f.run, 'rin.env')), false);
    assert.equal(readdirSync(f.run).filter((name) => name.startsWith('rin-deploy.')).length, 0);
    if (failed) assert.doesNotMatch(f.calls(), /pull|compose|kill --signal|rm -f old/);
    else assert.match(f.calls(), /kill --signal=SIGTERM old-worker/);
  }));
}

test('SSM failure cleans partial env before any Compose mutation', () => withFixture((f) => {
  const r = f.exec('deploy/ec2/deploy.sh', [image], { TEST_SSM_FAIL: '1' });
  assert.notEqual(r.status, 0); assert.doesNotMatch(f.calls(), /compose/);
  assert.equal(readdirSync(f.run).filter((name) => name.startsWith('rin.env')).length, 0);
}));
