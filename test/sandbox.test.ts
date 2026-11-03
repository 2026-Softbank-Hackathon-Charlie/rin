import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://rin:rin@localhost:5433/rin_test';
const { sandboxArgs } = await import('../src/worker/sandbox.js');

const args = sandboxArgs({
  cfg: { image: 'registry/hopcharlie/rin:abc', hostData: '/srv/rin/data', network: 'rin_default' },
  name: 'rin-sbx-7-a1b2c3',
  jobId: 7,
  cwd: '/data/workspace',
  envKeys: ['ANTHROPIC_API_KEY', 'GH_TOKEN', 'PATH'],
  command: '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
  args: ['--output-format', 'stream-json'],
});

const values = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

test('only /data is mounted, read-write and shared by every sandbox', () => {
  assert.deepEqual(values('-v'), ['/srv/rin/data:/data']);
});

test('environment is passed by name only, so values never appear in the arguments', () => {
  assert.deepEqual(values('-e'), ['ANTHROPIC_API_KEY', 'GH_TOKEN', 'PATH']);
  assert.ok(values('-e').every((v) => !v!.includes('=')));
});

test('no Docker socket, no privileges, removed on exit, labelled with the job', () => {
  assert.ok(!args.some((a) => a.includes('docker.sock')));
  assert.ok(!args.includes('--privileged'));
  assert.ok(args.includes('--rm') && args.includes('-i') && args.includes('--init'));
  assert.deepEqual(values('--label'), ['rin.sandbox.job=7']);
  assert.deepEqual(values('--network'), ['rin_default']);
});

test('the image comes right before the Claude Code command and its arguments', () => {
  const at = args.indexOf('registry/hopcharlie/rin:abc');
  assert.deepEqual(args.slice(at), [
    'registry/hopcharlie/rin:abc',
    '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    '--output-format',
    'stream-json',
  ]);
});
