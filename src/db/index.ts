import postgres from 'postgres';
import { need } from '../config.js';
import { migrations } from './migrations.js';

// Git operations hold a transaction-level advisory lock for their duration, so leave room in the pool.
export const sql = postgres(need('DATABASE_URL'), { max: 10, onnotice: () => {} });

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export type Job = {
  id: number;
  kind: 'slack' | 'schedule';
  channel: string;
  thread_ts: string | null;
  trigger_ts: string | null;
  requester: string | null;
  prompt: string;
  status: JobStatus;
  status_ts: string | null;
  cancel_requested_by: string | null;
  schedule_id: number | null;
  worker_id: string | null;
  resumed: number;
  cost_usd: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

export type ThreadRow = {
  thread_ts: string;
  channel: string;
  session_id: string | null;
  last_read_ts: string | null;
  session_cost_usd: string | null;
  updated_at: Date;
};

export type WorktreeRow = {
  id: number;
  thread_ts: string;
  repo: string;
  path: string;
  branch: string;
  created_at: Date;
  last_used_at: Date;
};

export type ScheduleRow = {
  id: number;
  title: string;
  cron: string;
  prompt: string;
  created_by: string;
  enabled: boolean;
  next_run_at: Date;
  last_run_at: Date | null;
  fail_streak: number;
  created_at: Date;
};

/** Applies pending migrations. Safe to call from gateway and worker at the same time. */
export async function migrate(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7316001)`;
    await tx`create table if not exists schema_migrations (id int primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx<{ id: number }[]>`select id from schema_migrations`).map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await tx.unsafe(m.sql);
      await tx`insert into schema_migrations (id) values (${m.id})`;
    }
  });
}

export async function getSetting(key: string): Promise<string | undefined> {
  const rows = await sql<{ value: string }[]>`select value from settings where key = ${key}`;
  return rows[0]?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await sql`insert into settings (key, value) values (${key}, ${value})
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/** Estimated spend this month in Asia/Seoul, from the SDK cost of every finished job. */
export async function monthCostUsd(): Promise<number> {
  const rows = await sql<{ total: string }[]>`
    select coalesce(sum(cost_usd), 0)::text as total from jobs
    where created_at >= (date_trunc('month', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')`;
  return Number(rows[0]?.total ?? 0);
}
