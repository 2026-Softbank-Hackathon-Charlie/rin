import { WebClient } from '@slack/web-api';
import { config, healthPort, need } from '../config.js';
import { migrate, sql, type Job } from '../db/index.js';
import { ensureReader } from '../db/reader.js';
import { startHealthServer } from '../health.js';
import { statusBlocks } from '../slack/blocks.js';
import { claimNext, forgetOldWorkers, heartbeat, isLeader, jobsOfDeadWorkers, leaveWorkers, requeueForResume, workerId } from './coord.js';
import { cleanupAttachments } from './attachments.js';
import { runJob, type RunHandle } from './run.js';
import { checkSandbox, sweepSandboxes } from './sandbox.js';
import { dispatchDueSchedules } from './scheduler.js';
import { ensureWorkspace } from './workspace.js';

const client = new WebClient(need('SLACK_BOT_TOKEN'));
const handles = new Map<number, RunHandle>();
let botUserId = '';
let draining = false;
let ticking = false;
let lastTick = Date.now();
let lastHeartbeat = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function markMessage(job: Job, header: string, cancellable = false): Promise<void> {
  if (!job.status_ts) return;
  await client.chat
    .update({ channel: job.channel, ts: job.status_ts, text: header.replace(/\*/g, ''), blocks: statusBlocks({ header, jobId: job.id, cancellable }) })
    .catch((err) => console.error('could not update status message', err?.data?.error ?? err));
}

function start(job: Job): void {
  const handle: RunHandle = { controller: new AbortController() };
  handles.set(job.id, handle);
  runJob(job, { client, botUserId, handle })
    .catch(async (err) => {
      console.error(`job ${job.id} crashed`, err);
      await sql`update jobs set status = 'failed', error = ${String(err).slice(0, 500)}, finished_at = now()
                where id = ${job.id} and status = 'running'`;
      await markMessage(job, '*Rin* 실패 | 내부 오류');
    })
    .finally(() => handles.delete(job.id));
}

/** Every second: heartbeat, cancellations, and new jobs while the global limit allows. */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  lastTick = Date.now();
  try {
    if (Date.now() - lastHeartbeat > 5000) {
      await heartbeat(draining);
      lastHeartbeat = Date.now();
    }
    if (handles.size > 0) {
      const ids = [...handles.keys()];
      const rows = await sql<{ id: number; cancel_requested_by: string }[]>`
        select id, cancel_requested_by from jobs where id in ${sql(ids)} and cancel_requested_by is not null`;
      for (const row of rows) {
        const handle = handles.get(row.id);
        if (handle && !handle.controller.signal.aborted) {
          handle.reason = { kind: 'cancel', by: row.cancel_requested_by };
          handle.controller.abort();
        }
      }
    }
    while (!draining) {
      const job = await claimNext(config.concurrency);
      if (!job) break;
      start(job);
    }
  } catch (err) {
    console.error('tick failed', errText(err));
  } finally {
    ticking = false;
  }
}

/** Jobs of a worker that died without draining (crash, kill, reboot) are queued again to resume once. */
async function reapDeadWorkers(): Promise<void> {
  for (const job of await jobsOfDeadWorkers()) {
    const requeued = await requeueForResume(job.id, null);
    console.warn(`job ${job.id} of dead worker ${job.worker_id}: ${requeued ? 'queued to resume' : 'interrupted'}`);
    await markMessage(job, requeued ? '*Rin* 재시작으로 잠시 멈춤 | 곧 이어서 진행합니다' : '*Rin* 재시작으로 중단됨', requeued);
  }
  await forgetOldWorkers();
}

/** Work that must happen once across workers runs only on the leader. */
function leaderTask(name: string, intervalMs: number, fn: () => Promise<void>): void {
  const run = async () => {
    if (draining || !(await isLeader())) return;
    await fn();
  };
  setInterval(() => void run().catch((err) => console.error(`${name} failed`, errText(err))), intervalMs);
}

/**
 * Stop signal, also sent by deploy.sh to the old worker of a handoff: take no new jobs, let running ones
 * finish (up to RIN_DRAIN_MS, 2 hours by default), queue whatever is left to resume on the new worker, exit.
 */
async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  console.log(`${signal}: draining, ${handles.size} running job(s), up to ${Math.round(config.drainMs / 60_000)} min`);
  await heartbeat(true).catch(() => {});
  const deadline = Date.now() + config.drainMs;
  while (handles.size > 0 && Date.now() < deadline) await sleep(1000);
  for (const handle of handles.values()) {
    handle.reason = { kind: 'shutdown' };
    handle.controller.abort();
  }
  const hardStop = Date.now() + 30_000;
  while (handles.size > 0 && Date.now() < hardStop) await sleep(500);
  await leaveWorkers().catch(() => {});
  await sql.end({ timeout: 5 });
  console.log('drained, exiting');
  process.exit(0);
}

async function main(): Promise<void> {
  await migrate();
  await ensureReader().catch((err) => console.error('could not set the read-only DB role password; psql will not work', errText(err)));
  ensureWorkspace();
  await checkSandbox();
  botUserId = (await client.auth.test()).user_id ?? '';
  await heartbeat(false);
  lastHeartbeat = Date.now();
  startHealthServer(healthPort('worker'), () => Date.now() - lastTick < 15_000);
  setInterval(() => void tick(), 1000);
  leaderTask('schedules', 30_000, () => dispatchDueSchedules());
  leaderTask('reaper', 30_000, reapDeadWorkers);
  leaderTask('attachment cleanup', 3600_000, cleanupAttachments);
  leaderTask('sandbox sweep', 10 * 60_000, sweepSandboxes);
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  const where = config.sandbox ? `a sandbox container per run (${config.sandbox.image})` : 'the worker container';
  console.log(`worker ${workerId} ready: concurrency ${config.concurrency} across workers, workspace ${config.workspaceDir}, Claude runs in ${where}`);
}

main().catch((err) => {
  console.error('worker failed to start', err);
  process.exit(1);
});
