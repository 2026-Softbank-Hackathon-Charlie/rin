import { config } from '../config.js';
import { sql, type ScheduleRow } from '../db/index.js';
import { nextRunAfter } from './cron.js';

/**
 * Turns due schedules into queued jobs. A schedule whose previous run is still queued or running
 * skips this round, so a slow job never piles up copies of itself.
 */
export async function dispatchDueSchedules(now = new Date()): Promise<void> {
  const due = await sql<ScheduleRow[]>`select * from schedules where enabled and next_run_at <= ${now} order by next_run_at`;
  for (const s of due) {
    const busy = await sql`select 1 from jobs where schedule_id = ${s.id} and status in ('queued', 'running') limit 1`;
    if (busy.length === 0) {
      await sql`
        insert into jobs (kind, channel, requester, prompt, schedule_id)
        values ('schedule', ${config.channelId}, ${s.created_by}, ${s.prompt}, ${s.id})`;
    } else {
      console.log(`schedule ${s.id} skipped: previous run still in progress`);
    }
    const next = nextRunAfter(s.cron, now);
    await sql`
      update schedules set
        last_run_at = ${now},
        next_run_at = ${next ?? s.next_run_at},
        enabled = ${next !== null}
      where id = ${s.id}`;
  }
}
