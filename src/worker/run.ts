import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WebClient } from '@slack/web-api';
import { config, displayName } from '../config.js';
import { getSetting, monthCostUsd, sql, type Job, type ThreadRow } from '../db/index.js';
import { asksForMerge } from '../agent/guards.js';
import { logLines } from '../agent/logfmt.js';
import { buildOptions } from '../agent/options.js';
import { statusBlocks } from '../slack/blocks.js';
import { formatDuration, formatUsd, splitMessage, tail } from '../slack/text.js';
import { StatusMessage } from './status.js';
import { buildPrompt, fetchThread } from './thread.js';

export type AbortReason = { kind: 'cancel'; by: string } | { kind: 'shutdown' };
export type RunHandle = { controller: AbortController; reason?: AbortReason };

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

/** Runs one Slack job end to end: thread context, Claude run with a live status message, final answer. */
export async function runJob(job: Job, deps: { client: WebClient; botUserId: string; handle: RunHandle }): Promise<void> {
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
  const liveHeader = () => `*Rin* 작업 중 | 도구 ${toolCalls}회 | ${formatDuration(Date.now() - started)} | ${model}`;

  status?.push(frame(`*Rin* 시작하는 중 | ${model}`, true));

  const thread = (await sql<ThreadRow[]>`select * from threads where thread_ts = ${threadTs}`)[0];
  const messages = await fetchThread(client, job.channel, threadTs);

  let sessionId: string | undefined;
  let result: SDKResultMessage | undefined;
  let error: unknown;

  const attempt = async (resume: string | undefined) => {
    let sawAssistant = false;
    const prompt = buildPrompt({
      messages,
      triggerTs: job.trigger_ts!,
      sinceTs: resume ? (thread?.last_read_ts ?? null) : null,
      botUserId,
      hasSession: !!resume,
    });
    try {
      const run = query({
        prompt,
        options: buildOptions({
          model,
          resume,
          abortController: handle.controller,
          mergeAllowed: asksForMerge(job.prompt),
          stderr: (s) => console.error(`[job ${job.id}] ${s.trimEnd()}`),
        }),
      });
      for await (const m of run) {
        if (m.type === 'system' && m.subtype === 'init') {
          sessionId = m.session_id;
          await saveThread(threadTs, job.channel, m.session_id, null);
        } else if (m.type === 'assistant') {
          sawAssistant = true;
        } else if (m.type === 'result') {
          result = m;
        }
        const { lines, toolCalls: n } = logLines(m);
        if (lines.length) {
          toolCalls += n;
          log = tail(log + lines.join('\n') + '\n', config.logTailChars * 4);
          status?.push(frame(liveHeader(), true));
        }
      }
    } catch (e) {
      error = e;
    }
    return { sawAssistant };
  };

  const first = await attempt(thread?.session_id ?? undefined);
  const resumeFailed = thread?.session_id && !first.sawAssistant && !handle.controller.signal.aborted && (error || result?.subtype !== 'success');
  if (resumeFailed) {
    console.warn(`job ${job.id}: resume of ${thread?.session_id} failed, starting a new session`, error);
    log += '(이전 세션을 이어 가지 못해 새 세션으로 다시 시작한다)\n';
    error = undefined;
    result = undefined;
    await attempt(undefined);
  }

  const elapsed = formatDuration(Date.now() - started);
  const cost = result?.total_cost_usd ?? null;
  if (sessionId) await saveThread(threadTs, job.channel, sessionId, job.trigger_ts);

  if (handle.controller.signal.aborted) {
    const reason = handle.reason ?? { kind: 'cancel', by: '' };
    const header =
      reason.kind === 'cancel' ? `*Rin* 취소됨 | ${displayName(reason.by)}님이 취소 | ${elapsed}` : `*Rin* 재시작으로 중단됨 | ${elapsed}`;
    await sql`update jobs set status = ${reason.kind === 'cancel' ? 'cancelled' : 'interrupted'},
              cost_usd = ${cost}, finished_at = now() where id = ${job.id}`;
    await status?.close(frame(header, false));
    return;
  }

  if (result?.subtype === 'success') {
    await sql`update jobs set status = 'done', cost_usd = ${cost}, finished_at = now() where id = ${job.id}`;
    const month = await monthCostUsd();
    const footer = `_소요 ${elapsed} | 이번 ${formatUsd(cost ?? 0)} | 이번 달 ${formatUsd(month)} | ${model}_`;
    const chunks = splitMessage(`${result.result.trim() || '(답이 비어 있다)'}\n\n${footer}`);
    const [head, ...rest] = chunks;
    if (status) await status.close({ text: head ?? footer, blocks: [] });
    else await client.chat.postMessage({ channel: job.channel, thread_ts: threadTs, text: head ?? footer });
    for (const chunk of rest) await client.chat.postMessage({ channel: job.channel, thread_ts: threadTs, text: chunk });
    return;
  }

  const reason = failureReason(result, error);
  console.error(`job ${job.id} failed: ${reason}`, error);
  await sql`update jobs set status = 'failed', cost_usd = ${cost}, error = ${reason}, finished_at = now() where id = ${job.id}`;
  await status?.close(frame(`*Rin* 실패 | ${reason} | ${elapsed}`, false));
}
