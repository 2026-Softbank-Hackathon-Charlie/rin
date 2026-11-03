import crypto from 'node:crypto';
import { config } from '../config.js';
import { sql, type Job } from '../db/index.js';

/**
 * Coordination between workers. During a handoff deploy the old and the new worker run side by side
 * on one database, so everything that must happen once is decided here, not inside one process.
 */
export const workerId = `${config.version}-${crypto.randomBytes(3).toString('hex')}`;

const CLAIM_LOCK = 7316003;

export async function heartbeat(draining: boolean): Promise<void> {
  await sql`
    insert into workers (id, version, draining) values (${workerId}, ${config.version}, ${draining})
    on conflict (id) do update set heartbeat_at = now(), draining = excluded.draining`;
}

export async function leaveWorkers(): Promise<void> {
  await sql`delete from workers where id = ${workerId}`;
}

/**
 * The leader is the newest live worker that is not draining. Only the leader dispatches schedules,
 * syncs repos, cleans worktrees and reaps jobs of dead workers. A new worker takes over as soon as it
 * heartbeats; if it dies, its heartbeat goes stale and the old one leads again.
 */
export async function isLeader(): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    select id from workers
    where not draining and heartbeat_at > now() - interval '30 seconds'
    order by started_at desc
    limit 1`;
  return row?.id === workerId;
}

/**
 * Claims the oldest runnable job for this worker while fewer than `limit` jobs run across all workers.
 * A job waits while another job of the same thread runs, on any worker.
 */
export async function claimNext(limit: number): Promise<Job | undefined> {
  const rows = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${CLAIM_LOCK})`;
    const [count] = await tx<{ running: number }[]>`select count(*)::int as running from jobs where status = 'running'`;
    if ((count?.running ?? 0) >= limit) return [];
    return tx<Job[]>`
      update jobs set status = 'running', started_at = now(), worker_id = ${workerId}
      where id = (
        select j.id from jobs j
        where j.status = 'queued'
          and (j.kind <> 'slack' or j.status_ts is not null)
          and not exists (select 1 from jobs r where r.status = 'running' and r.thread_ts = j.thread_ts)
        order by j.id
        limit 1
        for update skip locked)
      returning *`;
  });
  return (rows as Job[])[0];
}

/**
 * Puts a job that was cut off (redeploy, crash, reboot) back in the queue so a worker resumes it.
 * A job is resumed at most once; after that it ends as interrupted. Returns true when it was queued again.
 */
export async function requeueForResume(jobId: number, costUsd: number | null): Promise<boolean> {
  const [row] = await sql<{ status: string }[]>`
    update jobs set
      status = case when resumed < 1 then 'queued' else 'interrupted' end,
      resumed = case when resumed < 1 then resumed + 1 else resumed end,
      worker_id = null,
      started_at = case when resumed < 1 then null else started_at end,
      finished_at = case when resumed < 1 then null else now() end,
      cost_usd = coalesce(cost_usd, 0) + ${costUsd ?? 0}
    where id = ${jobId} and status = 'running'
    returning status`;
  return row?.status === 'queued';
}

/** Running jobs whose worker stopped heartbeating more than 90 seconds ago. Jobs of pre-handoff workers (no worker_id) are left alone. */
export async function jobsOfDeadWorkers(): Promise<Job[]> {
  return sql<Job[]>`
    select j.* from jobs j
    left join workers w on w.id = j.worker_id
    where j.status = 'running'
      and j.worker_id is not null
      and j.worker_id <> ${workerId}
      and (w.id is null or w.heartbeat_at < now() - interval '90 seconds')`;
}

export async function forgetOldWorkers(): Promise<void> {
  await sql`delete from workers where heartbeat_at < now() - interval '1 day'`;
}
