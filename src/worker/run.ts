import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WebClient } from '@slack/web-api';
import { aiAwsEnv, config, displayName } from '../config.js';
import { getSetting, monthCostUsd, sql, type Job, type ScheduleRow, type ThreadRow } from '../db/index.js';
import { botIdentity, installationToken } from '../github/app.js';
import { asksForMerge } from '../agent/guards.js';
import { logLines } from '../agent/logfmt.js';
import { buildOptions } from '../agent/options.js';
import { rinToolServer } from '../agent/tools.js';
import { statusBlocks } from '../slack/blocks.js';
import { formatDuration, formatUsd, splitMessage, tail } from '../slack/text.js';
import { syncRepos } from './repos.js';
import { StatusMessage } from './status.js';
import { requeueForResume } from './coord.js';
import { buildPrompt, buildSchedulePrompt, fetchThread } from './thread.js';

export type AbortReason = { kind: 'cancel'; by: string } | { kind: 'shutdown' };
export type RunHandle = { controller: AbortController; reason?: AbortReason };
type Deps = { client: WebClient; botUserId: string; handle: RunHandle };

async function saveThread(threadTs: string, channel: string, sessionId: string, lastReadTs: string | null): Promise<void> {
  await sql`
    insert into threads (thread_ts, channel, session_id, last_read_ts)
    values (${threadTs}, ${channel}, ${sessionId}, ${lastReadTs})
    on conflict (thread_ts) do update set
      session_id = excluded.session_id,
      last_read_ts = coalesce(excluded.last_read_ts, threads.last_read_ts),
      updated_at = now()`;
}

function failureReason(result: SDKResultMessage | undefined, error: unknown): string {
  if (result && result.subtype !== 'success') {
    switch (result.subtype) {
      case 'error_max_turns':
        return `턴 한도(${config.maxTurns})에 닿았다`;
      case 'error_max_budget_usd':
        return `실행당 예산 한도(${formatUsd(config.maxBudgetUsd)})에 닿았다`;
      default:
        return `실행 중 오류: ${result.errors.join('; ').slice(0, 300) || result.subtype}`;
    }
  }
  if (error instanceof Error) return `실행 중 오류: ${error.message.slice(0, 300)}`;
  return '결과 없이 끝났다';
}

/** Environment for the Claude process: GitHub installation token and bot identity, view-only AWS keys. */
async function toolEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...aiAwsEnv() };
  try {
    const token = await installationToken();
    if (token) {
      env.GH_TOKEN = token;
      const id = await botIdentity();
      if (id) {
        env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = id.name;
        env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = id.email;
      }
      await syncRepos();
    }
  } catch (err) {
    console.error('GitHub setup failed; running without it', err instanceof Error ? err.message : err);
  }
  return env;
}

type Execution = { result?: SDKResultMessage; error?: unknown; sessionId?: string; sawAssistant: boolean };

/** One Claude run. Streams log lines to `onLog` and records the session as soon as it starts. */
async function execute(p: {
  deps: Deps;
  job: Job;
  model: string;
  prompt: string;
  resume?: string;
  worktreeKey: string;
  mergeAllowed: boolean;
  env: Record<string, string>;
  onSession: (sessionId: string) => Promise<void>;
  onLog?: (lines: string[], toolCalls: number) => void;
}): Promise<Execution> {
  const out: Execution = { sawAssistant: false };
  try {
    const run = query({
      prompt: p.prompt,
      options: buildOptions({
        model: p.model,
        resume: p.resume,
        abortController: p.deps.handle.controller,
        mergeAllowed: p.mergeAllowed,
        env: p.env,
        mcpServers: {
          rin: rinToolServer({ client: p.deps.client, botUserId: p.deps.botUserId, worktreeKey: p.worktreeKey, requester: p.job.requester }),
        },
        stderr: (s) => console.error(`[job ${p.job.id}] ${s.trimEnd()}`),
      }),
    });
    for await (const m of run) {
      if (m.type === 'system' && m.subtype === 'init') {
        out.sessionId = m.session_id;
        await p.onSession(m.session_id);
      } else if (m.type === 'assistant') {
        out.sawAssistant = true;
      } else if (m.type === 'result') {
        out.result = m;
      }
      const { lines, toolCalls } = logLines(m);
      if (lines.length) p.onLog?.(lines, toolCalls);
    }
  } catch (err) {
    out.error = err;
  }
  return out;
}

export async function runJob(job: Job, deps: Deps): Promise<void> {
  if (job.kind === 'schedule') return runScheduleJob(job, deps);
  return runSlackJob(job, deps);
}

/** A mention or DM: thread context, live status message with log tail and cancel button, answer in the thread. */
async function runSlackJob(job: Job, deps: Deps): Promise<void> {
  const { client, botUserId, handle } = deps;
  if (!job.thread_ts || !job.trigger_ts) throw new Error(`job ${job.id} has no thread`);
  const threadTs = job.thread_ts;
  const started = Date.now();
  const model = (await getSetting('model')) ?? config.defaultModel;
  const status = job.status_ts ? new StatusMessage(client, job.channel, job.status_ts) : undefined;

  let log = '';
  let toolCalls = 0;
  const frame = (header: string, cancellable: boolean) => ({
    text: header.replace(/\*/g, ''),
    blocks: statusBlocks({ header, log: tail(log, config.logTailChars), jobId: job.id, cancellable }),
  });
  status?.push(frame(job.resumed > 0 ? `*Rin* 이어서 진행하는 중 | ${model}` : `*Rin* 시작하는 중 | ${model}`, true));

  const thread = (await sql<ThreadRow[]>`select * from threads where thread_ts = ${threadTs}`)[0];
  const messages = await fetchThread(client, job.channel, threadTs);
  const env = await toolEnv();
  const place = job.channel === config.channelId ? 'channel' : 'dm';

  const attempt = (resume: string | undefined) =>
    execute({
      deps,
      job,
      model,
      resume,
      worktreeKey: threadTs,
      mergeAllowed: asksForMerge(job.prompt),
      env,
      prompt: buildPrompt({
        messages,
        triggerTs: job.trigger_ts!,
        sinceTs: resume ? (thread?.last_read_ts ?? null) : null,
        botUserId,
        hasSession: !!resume,
        place,
        resuming: job.resumed > 0,
      }),
      onSession: (id) => saveThread(threadTs, job.channel, id, null),
      onLog: (lines, n) => {
        toolCalls += n;
        log = tail(log + lines.join('\n') + '\n', config.logTailChars * 4);
        status?.push(frame(`*Rin* 작업 중 | 도구 ${toolCalls}회 | ${formatDuration(Date.now() - started)} | ${model}`, true));
      },
    });

  let exec = await attempt(thread?.session_id ?? undefined);
  const resumeFailed =
    thread?.session_id && !exec.sawAssistant && !handle.controller.signal.aborted && (exec.error || exec.result?.subtype !== 'success');
  if (resumeFailed) {
    console.warn(`job ${job.id}: resume of ${thread?.session_id} failed, starting a new session`, exec.error);
    log += '(이전 세션을 이어 가지 못해 새 세션으로 다시 시작한다)\n';
    exec = await attempt(undefined);
  }

  const elapsed = formatDuration(Date.now() - started);
  const cost = exec.result?.total_cost_usd ?? null;
  if (exec.sessionId) await saveThread(threadTs, job.channel, exec.sessionId, job.trigger_ts);

  if (handle.controller.signal.aborted) {
    const reason = handle.reason ?? { kind: 'cancel', by: '' };
    // A redeploy cut this run off: queue it again so the next worker resumes the same session.
    if (reason.kind === 'shutdown' && (await requeueForResume(job.id, cost))) {
      await status?.close(frame('*Rin* 재배포로 잠시 멈춤 | 곧 이어서 진행합니다', true));
      return;
    }
    const header =
      reason.kind === 'cancel' ? `*Rin* 취소됨 | ${displayName(reason.by)}님이 취소 | ${elapsed}` : `*Rin* 재시작으로 중단됨 | ${elapsed}`;
    await sql`update jobs set status = ${reason.kind === 'cancel' ? 'cancelled' : 'interrupted'},
              cost_usd = coalesce(cost_usd, 0) + ${cost ?? 0}, finished_at = now()
              where id = ${job.id} and status = 'running'`;
    await status?.close(frame(header, false));
    return;
  }

  if (exec.result?.subtype === 'success') {
    await sql`update jobs set status = 'done', cost_usd = coalesce(cost_usd, 0) + ${cost ?? 0}, finished_at = now() where id = ${job.id}`;
    const footer = `_소요 ${elapsed} | 이번 ${formatUsd(cost ?? 0)} | 이번 달 ${formatUsd(await monthCostUsd())} | ${model}_`;
    const [head, ...rest] = splitMessage(`${exec.result.result.trim() || '(답이 비어 있다)'}\n\n${footer}`);
    if (status) await status.close({ text: head ?? footer, blocks: [] });
    else await client.chat.postMessage({ channel: job.channel, thread_ts: threadTs, text: head ?? footer });
    for (const chunk of rest) await client.chat.postMessage({ channel: job.channel, thread_ts: threadTs, text: chunk });
    return;
  }

  const reason = failureReason(exec.result, exec.error);
  console.error(`job ${job.id} failed: ${reason}`, exec.error);
  await sql`update jobs set status = 'failed', cost_usd = coalesce(cost_usd, 0) + ${cost ?? 0}, error = ${reason}, finished_at = now() where id = ${job.id}`;
  await status?.close(frame(`*Rin* 실패 | ${reason} | ${elapsed}`, false));
}

/** A scheduled run: no status message; the answer goes to the team channel as a new message, overflow in its thread. */
async function runScheduleJob(job: Job, deps: Deps): Promise<void> {
  const { client, handle } = deps;
  const started = Date.now();
  const model = (await getSetting('model')) ?? config.defaultModel;
  const schedule = job.schedule_id ? (await sql<ScheduleRow[]>`select * from schedules where id = ${job.schedule_id}`)[0] : undefined;
  const title = schedule?.title ?? `예약 작업 ${job.schedule_id ?? ''}`.trim();
  const env = await toolEnv();

  const exec = await execute({
    deps,
    job,
    model,
    worktreeKey: `schedule-${job.id}`,
    mergeAllowed: false,
    env,
    prompt: buildSchedulePrompt({ id: job.schedule_id ?? 0, title, prompt: job.prompt, createdBy: job.requester ?? '' }),
    onSession: async () => {},
  });

  const elapsed = formatDuration(Date.now() - started);
  const cost = exec.result?.total_cost_usd ?? null;

  if (handle.controller.signal.aborted) {
    // A redeploy cut it off: run it again on the next worker (schedule runs keep no session, so it starts over).
    if (handle.reason?.kind === 'shutdown' && (await requeueForResume(job.id, cost))) return;
    const kind = handle.reason?.kind === 'cancel' ? 'cancelled' : 'interrupted';
    await sql`update jobs set status = ${kind}, cost_usd = coalesce(cost_usd, 0) + ${cost ?? 0}, finished_at = now()
              where id = ${job.id} and status = 'running'`;
    return;
  }

  if (exec.result?.subtype === 'success') {
    const footer = `_예약 #${job.schedule_id} | 소요 ${elapsed} | 이번 ${formatUsd(cost ?? 0)} | ${model}_`;
    const [head, ...rest] = splitMessage(`*[예약] ${title}*\n${exec.result.result.trim() || '(답이 비어 있다)'}\n\n${footer}`);
    const posted = await client.chat.postMessage({ channel: job.channel, text: head ?? footer });
    const ts = posted.ts!;
    for (const chunk of rest) await client.chat.postMessage({ channel: job.channel, thread_ts: ts, text: chunk });
    // A mention in this thread continues the scheduled run's session.
    if (exec.sessionId) await saveThread(ts, job.channel, exec.sessionId, ts);
    await sql`update jobs set status = 'done', thread_ts = ${ts}, cost_usd = coalesce(cost_usd, 0) + ${cost ?? 0}, finished_at = now() where id = ${job.id}`;
    if (job.schedule_id) await sql`update schedules set fail_streak = 0 where id = ${job.schedule_id}`;
    return;
  }

  const reason = failureReason(exec.result, exec.error);
  console.error(`schedule job ${job.id} failed: ${reason}`, exec.error);
  await sql`update jobs set status = 'failed', cost_usd = coalesce(cost_usd, 0) + ${cost ?? 0}, error = ${reason}, finished_at = now() where id = ${job.id}`;
  const posted = await client.chat.postMessage({ channel: job.channel, text: `*[예약] ${title}* 실패: ${reason}` });
  if (!job.schedule_id) return;
  const [row] = await sql<{ fail_streak: number }[]>`
    update schedules set fail_streak = fail_streak + 1 where id = ${job.schedule_id} returning fail_streak`;
  if (row && row.fail_streak >= 3) {
    await sql`update schedules set enabled = false where id = ${job.schedule_id}`;
    await client.chat.postMessage({
      channel: job.channel,
      thread_ts: posted.ts,
      text: `예약 #${job.schedule_id}이 연속 3번 실패해서 껐습니다. 원인을 고친 뒤 \`@Rin 예약 #${job.schedule_id} 다시 켜줘\`라고 하면 됩니다.`,
    });
  }
}
