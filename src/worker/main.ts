import { WebClient } from '@slack/web-api';
import { config, healthPort, need } from '../config.js';
import { migrate, sql, type Job } from '../db/index.js';
import { startHealthServer } from '../health.js';
import { statusBlocks } from '../slack/blocks.js';
import { cleanupWorktrees, syncRepos } from './repos.js';
import { runJob, type RunHandle } from './run.js';
import { dispatchDueSchedules } from './scheduler.js';
import { ensureWorkspace } from './workspace.js';

const client = new WebClient(need('SLACK_BOT_TOKEN'));
const handles = new Map<number, RunHandle>();
let botUserId = '';
let draining = false;
let ticking = false;
let lastTick = Date.now();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function markMessage(job: Job, header: string): Promise<void> {
  if (!job.status_ts) return;
  await client.chat
    .update({ channel: job.channel, ts: job.status_ts, text: header.replace(/\*/g, ''), blocks: statusBlocks({ header, cancellable: false }) })
    .catch((err) => console.error('could not update status message', err?.data?.error ?? err));
}

/** Jobs left running by a crash or kill are closed as interrupted on start. */
async function recoverInterrupted(): Promise<void> {
  const stale = await sql<Job[]>`
    update jobs set status = 'interrupted', finished_at = now() where status = 'running' returning *`;
  for (const job of stale) await markMessage(job, '*Rin* 재시작으로 중단됨');
}

/** Takes the oldest queued job whose thread has nothing running. */
async function claim(): Promise<Job | undefined> {
  const rows = await sql<Job[]>`
    update jobs set status = 'running', started_at = now()
    where id = (
      select j.id from jobs j
      where j.status = 'queued'
        and (j.kind <> 'slack' or j.status_ts is not null)
        and not exists (select 1 from jobs r where r.status = 'running' and r.thread_ts = j.thread_ts)
      order by j.id
      limit 1
      for update skip locked)
    returning *`;
  return rows[0];
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

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  lastTick = Date.now();
  try {
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
    while (!draining && handles.size < config.concurrency) {
      const job = await claim();
      if (!job) break;
      start(job);
    }
  } catch (err) {
    console.error('tick failed', err);
  } finally {
    ticking = false;
  }
}

async function shutdown(signal: string): Promise<void> {
  if (draining) return;
  draining = true;
  console.log(`${signal}: no new jobs, waiting up to ${config.drainMs / 1000}s for ${handles.size} running job(s)`);
  const deadline = Date.now() + config.drainMs;
  while (handles.size > 0 && Date.now() < deadline) await sleep(1000);
  for (const handle of handles.values()) {
    handle.reason = { kind: 'shutdown' };
    handle.controller.abort();
  }
  const hardStop = Date.now() + 15_000;
  while (handles.size > 0 && Date.now() < hardStop) await sleep(500);
  await sql.end({ timeout: 5 });
  process.exit(0);
}

async function main(): Promise<void> {
  await migrate();
  ensureWorkspace();
  botUserId = (await client.auth.test()).user_id ?? '';
  await recoverInterrupted();
  startHealthServer(healthPort('worker'), () => Date.now() - lastTick < 15_000);
  setInterval(() => void tick(), 1000);
  const background = (name: string, fn: () => Promise<void>) => () =>
    void fn().catch((err) => console.error(`${name} failed`, err instanceof Error ? err.message : err));
  setInterval(background('schedules', () => (draining ? Promise.resolve() : dispatchDueSchedules())), 30_000);
  setInterval(background('worktree cleanup', cleanupWorktrees), 3600_000);
  background('repo sync', () => syncRepos(true))();
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  console.log(`worker ready: concurrency ${config.concurrency}, workspace ${config.workspaceDir}`);
}

main().catch((err) => {
  console.error('worker failed to start', err);
  process.exit(1);
});
