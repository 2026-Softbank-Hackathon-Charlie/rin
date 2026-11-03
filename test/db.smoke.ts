// Manual smoke test of the SQL against a real Postgres (compose.dev.yaml).
// Run: DATABASE_URL=postgres://rin:rin@localhost:5433/rin_test node --import tsx test/db.smoke.ts
import assert from 'node:assert/strict';
// This test truncates tables, so it refuses any database whose name does not end in _test.
if (!/\/[^/?]+_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('db.smoke.ts truncates tables; point DATABASE_URL at a database named *_test');
  process.exit(1);
}
const { getSetting, migrate, monthCostUsd, setSetting, sql } = await import('../src/db/index.js');

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

// Handoff deploy coordination.
const coord = await import('../src/worker/coord.js');
await sql`truncate workers`;
await coord.heartbeat(false);
assert.equal(await coord.isLeader(), true, 'the only live worker leads');
await sql`insert into workers (id, version, started_at) values ('newer', 'b', now() + interval '1 second')`;
assert.equal(await coord.isLeader(), false, 'a newer live worker takes over');
await sql`update workers set draining = true where id = 'newer'`;
assert.equal(await coord.isLeader(), true, 'a draining worker never leads');
await sql`update workers set draining = false, heartbeat_at = now() - interval '1 minute' where id = 'newer'`;
assert.equal(await coord.isLeader(), true, 'a stale worker never leads');

// The concurrency limit counts running jobs of every worker.
const queue = (ts: string) => sql`
  insert into jobs (kind, channel, thread_ts, trigger_ts, requester, prompt, status_ts)
  values ('slack', 'C1', ${ts}, ${ts}, 'U1', 'p', 'x')`;
await queue('10.0');
await queue('11.0');
await queue('12.0');
await sql`update jobs set status = 'running', worker_id = 'other' where trigger_ts = '10.0'`;
const first = await coord.claimNext(2);
assert.equal(first?.worker_id, coord.workerId);
assert.equal(await coord.claimNext(2), undefined, 'two running across workers is the limit');

// A cut-off job is queued again once, then ends as interrupted.
assert.equal(await coord.requeueForResume(first!.id, 0.1), true);
const [again] = await sql<{ status: string; resumed: number; worker_id: string | null }[]>`select status, resumed, worker_id from jobs where id = ${first!.id}`;
assert.deepEqual(again, { status: 'queued', resumed: 1, worker_id: null });
await sql`update jobs set status = 'running' where id = ${first!.id}`;
assert.equal(await coord.requeueForResume(first!.id, 0.1), false);
const [done] = await sql<{ status: string; cost_usd: string }[]>`select status, cost_usd from jobs where id = ${first!.id}`;
assert.equal(done!.status, 'interrupted');
assert.equal(Number(done!.cost_usd), 0.2, 'cost adds up across runs');

// Running jobs of a worker without a fresh heartbeat are found; this worker's and pre-handoff jobs are not.
await sql`update jobs set status = 'running', worker_id = 'gone' where trigger_ts = '11.0'`;
await sql`update jobs set status = 'running', worker_id = null where trigger_ts = '12.0'`;
const dead = await coord.jobsOfDeadWorkers();
assert.deepEqual(dead.map((j) => j.trigger_ts), ['10.0', '11.0']);
await coord.leaveWorkers();
await sql`truncate jobs, workers restart identity`;

await sql`truncate jobs, threads, settings restart identity`;
await sql.end();
console.log('db smoke test passed');
