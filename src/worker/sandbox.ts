import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { config, type SandboxConfig } from '../config.js';
import { sql } from '../db/index.js';

const run = promisify(execFile);

/**
 * Claude Code runs in a throwaway container per run (the sandbox), not in the worker.
 *
 * The sandbox gets only what Claude is meant to have: the environment the SDK passes (Anthropic key,
 * GitHub installation token, view-only AWS keys, read-only DB login) and /data. The Slack tokens, the
 * GitHub App key, the DB owner password and the Cloudflare token stay in the worker; Claude reaches the
 * worker's tools (mcp__rin__*) and hooks through the SDK's control channel on stdin and stdout.
 * Inside, Claude runs as node with sudo, so it can install what a task needs.
 */
const DATA = '/data';
const LABEL = 'rin.sandbox.job';
const MEMORY = '3g';
const PIDS = '4096';

export function sandboxArgs(p: {
  cfg: SandboxConfig;
  name: string;
  jobId: number;
  cwd: string;
  envKeys: string[];
  command: string;
  args: string[];
}): string[] {
  return [
    'run', '--rm', '-i', '--init',
    '--name', p.name,
    // The hostname is what tools report about this machine, e.g. "charlie v0.5.0 on rin-sbx-7-a1b2c3" on the
    // console's CLI login approval page, so an approver can tell a Rin run from a container id.
    '--hostname', p.name,
    '--label', `${LABEL}=${p.jobId}`,
    '--network', p.cfg.network,
    '--memory', MEMORY,
    '--pids-limit', PIDS,
    // Every sandbox shares /data, including the clones under workspace/repos/, so work in one run can be
    // picked up by another. The worker never runs git or anything else Claude wrote there.
    '-v', `${p.cfg.hostData}:${DATA}`,
    '-w', p.cwd,
    // `-e KEY` without a value copies it from the docker CLI's environment, so values stay out of the process list.
    ...p.envKeys.flatMap((key) => ['-e', key]),
    p.cfg.image,
    p.command,
    ...p.args,
  ];
}

async function removeSandbox(name: string): Promise<void> {
  await run('docker', ['rm', '-f', name]).catch(() => {});
}

/** The spawner for Options.spawnClaudeCodeProcess, or undefined when Claude runs in the worker (local development). */
export function sandboxSpawner(jobId: number, log: (text: string) => void): ((o: SpawnOptions) => SpawnedProcess) | undefined {
  const cfg = config.sandbox;
  if (!cfg) return undefined;
  return (o) => {
    const name = `rin-sbx-${jobId}-${crypto.randomBytes(3).toString('hex')}`;
    const env = Object.fromEntries(Object.entries(o.env).filter((e): e is [string, string] => e[1] !== undefined));
    const child = spawn(
      'docker',
      sandboxArgs({ cfg, name, jobId, cwd: o.cwd ?? config.workspaceDir, envKeys: Object.keys(env), command: o.command, args: o.args }),
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => log(text));
    // The container goes away with --rm when Claude exits. This covers a docker client that was killed first.
    o.signal.addEventListener('abort', () => void removeSandbox(name), { once: true });
    child.once('exit', () => void removeSandbox(name));
    return child;
  };
}

/**
 * Starts one empty sandbox with the same flags as a real run. Fails, and keeps the worker from becoming
 * healthy, when the worker cannot use Docker or the image, network or mounts are wrong.
 */
export async function checkSandbox(): Promise<void> {
  const cfg = config.sandbox;
  if (!cfg) return;
  const name = `rin-sbx-check-${crypto.randomBytes(3).toString('hex')}`;
  await run('docker', sandboxArgs({ cfg, name, jobId: 0, cwd: config.workspaceDir, envKeys: [], command: 'true', args: [] }));
}

/** Removes sandboxes whose job is not running any more, such as those of a worker that died. Leader only. */
export async function sweepSandboxes(): Promise<void> {
  if (!config.sandbox) return;
  const { stdout } = await run('docker', ['ps', '-a', '--filter', `label=${LABEL}`, '--format', `{{.Names}} {{.Label "${LABEL}"}}`]);
  const rows = stdout.split('\n').filter(Boolean).map((line) => line.split(' ') as [string, string]);
  if (rows.length === 0) return;
  const ids = [...new Set(rows.map(([, id]) => Number(id)))];
  const running = new Set((await sql<{ id: number }[]>`select id from jobs where id in ${sql(ids)} and status = 'running'`).map((r) => r.id));
  for (const [name, id] of rows) {
    if (running.has(Number(id))) continue;
    await removeSandbox(name);
    console.log(`removed sandbox ${name} (job ${id} is not running)`);
  }
}
