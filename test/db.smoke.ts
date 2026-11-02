// Manual smoke test of the SQL against a real Postgres (compose.dev.yaml).
// Run: DATABASE_URL=postgres://rin:rin@localhost:5433/rin node --import tsx test/db.smoke.ts
import assert from 'node:assert/strict';
import { getSetting, migrate, monthCostUsd, setSetting, sql } from '../src/db/index.js';

await migrate();
await migrate(); // idempotent
await sql`truncate jobs, threads, settings restart identity`;

const insert = (ts: string, thread: string) => sql<{ id: number }[]>`
  insert into jobs (kind, channel, thread_ts, trigger_ts, requester, prompt)
  values ('slack', 'C1', ${thread}, ${ts}, 'U1', 'hi')
  on conflict (channel, trigger_ts) where trigger_ts is not null do nothing
  returning id`;

const [a] = await insert('1.0', 'T1');
const dup = await insert('1.0', 'T1');
assert.equal(dup.length, 0, 'duplicate mention must not create a job');
const [b] = await insert('2.0', 'T1');
const [c] = await insert('3.0', 'T2');
assert.equal(typeof a!.id, 'number');

// Jobs without a status message are not claimable yet.
const claim = () => sql<{ id: number }[]>`
  update jobs set status = 'running', started_at = now()
  where id = (
    select j.id from jobs j
    where j.status = 'queued'
      and (j.kind <> 'slack' or j.status_ts is not null)
      and not exists (select 1 from jobs r where r.status = 'running' and r.thread_ts = j.thread_ts)
    order by j.id limit 1 for update skip locked)
  returning id`;
assert.equal((await claim()).length, 0);
await sql`update jobs set status_ts = 'x'`;

// Same thread runs one at a time; another thread can run alongside.
assert.equal((await claim())[0]!.id, a!.id);
assert.equal((await claim())[0]!.id, c!.id, 'T1 is busy, so T2 goes next');
assert.equal((await claim()).length, 0, 'b waits for a');
await sql`update jobs set status = 'done', cost_usd = 0.25 where id = ${a!.id}`;
assert.equal((await claim())[0]!.id, b!.id);

const cancelled = await sql<{ id: number }[]>`select id from jobs where id in ${sql([b!.id, c!.id])}`;
assert.equal(cancelled.length, 2);

await setSetting('model', 'claude-opus-5-5');
await setSetting('model', 'claude-sonnet-5-5');
assert.equal(await getSetting('model'), 'claude-sonnet-5-5');
assert.equal(await monthCostUsd(), 0.25);

// Schedules: a due schedule becomes one job; while that job is active the next round is skipped.
const { dispatchDueSchedules } = await import('../src/worker/scheduler.js');
await sql`truncate schedules restart identity cascade`;
const [s] = await sql<{ id: number }[]>`
  insert into schedules (title, cron, prompt, created_by, next_run_at)
  values ('t', '*/10 * * * *', 'p', 'U1', now() - interval '1 minute') returning id`;
await dispatchDueSchedules();
const scheduled = await sql<{ id: number; kind: string }[]>`select id, kind from jobs where schedule_id = ${s!.id}`;
assert.equal(scheduled.length, 1);
assert.equal(scheduled[0]!.kind, 'schedule');
const [after] = await sql<{ next_run_at: Date; enabled: boolean }[]>`select next_run_at, enabled from schedules where id = ${s!.id}`;
assert.ok(after!.next_run_at.getTime() > Date.now(), 'next run moved forward');
await sql`update schedules set next_run_at = now() - interval '1 minute' where id = ${s!.id}`;
await dispatchDueSchedules();
assert.equal((await sql`select 1 from jobs where schedule_id = ${s!.id}`).length, 1, 'skipped while the first run is queued');
// A one-off schedule turns itself off after dispatch.
const [once] = await sql<{ id: number }[]>`
  insert into schedules (title, cron, prompt, created_by, next_run_at)
  values ('once', ${new Date(Date.now() - 60_000).toISOString()}, 'p', 'U1', now() - interval '1 minute') returning id`;
await dispatchDueSchedules();
const [onceRow] = await sql<{ enabled: boolean }[]>`select enabled from schedules where id = ${once!.id}`;
assert.equal(onceRow!.enabled, false);
await sql`truncate jobs, schedules restart identity cascade`;

await sql`truncate jobs, threads, settings restart identity`;
await sql.end();
console.log('db smoke test passed');
