import { Cron } from 'croner';

export const MIN_INTERVAL_MS = 10 * 60_000;
export const TIMEZONE = 'Asia/Seoul';

export type CronPlan = { ok: true; next: Date[] } | { ok: false; reason: string };

/**
 * Validates a schedule. `when` is a 5-field cron expression read in KST, or an ISO date-time for a one-off run.
 * Repeating schedules must be at least 10 minutes apart. Returns up to three next run times.
 */
export function planSchedule(when: string, from: Date = new Date()): CronPlan {
  let job: Cron;
  try {
    job = new Cron(when.trim(), { timezone: TIMEZONE, paused: true });
  } catch (err) {
    return { ok: false, reason: `시각 표현을 읽을 수 없다: ${err instanceof Error ? err.message : String(err)}` };
  }
  const runs = job.nextRuns(6, from);
  job.stop();
  if (runs.length === 0) return { ok: false, reason: '앞으로 실행될 시각이 없다' };
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_INTERVAL_MS) {
      return { ok: false, reason: '반복 간격은 10분 이상이어야 한다' };
    }
  }
  return { ok: true, next: runs.slice(0, 3) };
}

/** Next run strictly after `after`, or null when the schedule has no more runs (a one-off that already ran). */
export function nextRunAfter(when: string, after: Date): Date | null {
  try {
    const job = new Cron(when.trim(), { timezone: TIMEZONE, paused: true });
    const next = job.nextRun(after);
    job.stop();
    return next;
  } catch {
    return null;
  }
}

export function formatKst(d: Date): string {
  return d.toLocaleString('ko-KR', { timeZone: TIMEZONE, hour12: false });
}
