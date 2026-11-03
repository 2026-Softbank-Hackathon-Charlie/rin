import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTeamMember } from '../src/config.js';
import { nextRunAfter, planSchedule } from '../src/worker/cron.js';
import { buildPrompt, buildSchedulePrompt } from '../src/worker/thread.js';

const FROM = new Date('2026-11-03T00:00:00Z'); // 09:00 KST

test('cron expressions are read in KST', () => {
  const plan = planSchedule('0 9 * * *', FROM);
  assert.equal(plan.ok, true);
  if (plan.ok) assert.equal(plan.next[0]!.toISOString(), '2026-11-04T00:00:00.000Z'); // tomorrow 09:00 KST
});

test('repeats closer than 10 minutes are refused', () => {
  const plan = planSchedule('*/5 * * * *', FROM);
  assert.equal(plan.ok, false);
  assert.equal(planSchedule('*/10 * * * *', FROM).ok, true);
});

test('an ISO time makes a one-off schedule that ends after it runs', () => {
  const plan = planSchedule('2026-11-03T12:00:00+09:00', FROM);
  assert.equal(plan.ok, true);
  if (plan.ok) assert.equal(plan.next.length, 1);
  assert.equal(nextRunAfter('2026-11-03T12:00:00+09:00', new Date('2026-11-03T03:00:01Z')), null);
});

test('garbage and past times are refused', () => {
  assert.equal(planSchedule('every morning', FROM).ok, false);
  assert.equal(planSchedule('2026-11-01T09:00:00+09:00', FROM).ok, false);
});

test('team members resolve from names, IDs and mentions only', () => {
  assert.equal(resolveTeamMember('김동윤'), 'U0C4A1HL3EH');
  assert.equal(resolveTeamMember('동윤님'), 'U0C4A1HL3EH');
  assert.equal(resolveTeamMember('<@U0C4J144FEH>'), 'U0C4J144FEH');
  assert.equal(resolveTeamMember('U0C4QG4TRAS'), 'U0C4QG4TRAS');
  assert.equal(resolveTeamMember('U0C1RN9FYMB'), undefined); // a mentor
  assert.equal(resolveTeamMember('아무개'), undefined);
});

test('prompts say where Rin was called from', () => {
  const dm = buildPrompt({
    messages: [{ ts: '1.0', user: 'U0C4K3UE58U', text: '안녕' }],
    triggerTs: '1.0',
    sinceTs: null,
    botUserId: 'UBOT',
    hasSession: false,
    place: 'dm',
  });
  assert.match(dm, /DM 스레드에서 호출/);
  const sched = buildSchedulePrompt({ id: 3, title: '아침 요약', prompt: '어제 대화 요약', createdBy: 'U0C4K3UE58U' });
  assert.match(sched, /예약 작업 #3 "아침 요약"/);
  assert.match(sched, /PR을 머지하지 않는다/);
  assert.match(sched, /\[지시\] 예약 작업 내용, 조서현님이 등록\n어제 대화 요약/);
  assert.match(sched, /팀 채널 #final_team_charlie 본문에 새 글로/);
  const quiet = buildSchedulePrompt({ id: 4, title: 'DM', prompt: 'DM 보내기', createdBy: 'U0C4K3UE58U', announce: false });
  assert.match(quiet, /Slack 어디에도 올라가지 않고/);
  assert.doesNotMatch(quiet, /본문에 새 글로/);
});
