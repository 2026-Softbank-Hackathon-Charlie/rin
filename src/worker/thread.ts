import type { WebClient } from '@slack/web-api';
import { config, displayName } from '../config.js';

export type SlackMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: unknown[];
};

/** Reads every message of a thread, oldest first. */
export async function fetchThread(client: WebClient, channel: string, threadTs: string): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 200, cursor });
    for (const m of res.messages ?? []) messages.push(m as SlackMessage);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return messages;
}

const tsNum = (ts: string | null | undefined) => (ts ? Number(ts) : 0);

function kst(ts: string): string {
  return new Date(Number(ts) * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

/** Rewrites mentions to readable names and neutralises the data-fence markers. */
export function clean(text: string, botUserId: string): string {
  return text
    .replaceAll(`<@${botUserId}>`, '@Rin')
    .replace(/<@([A-Z0-9]+)>/g, (_m, id: string) => `@${displayName(id)}`)
    .replace(/<<<|>>>/g, (s) => (s === '<<<' ? '‹‹‹' : '›››'))
    .trim();
}

/**
 * Builds the user prompt for one run.
 * Team members' messages are instructions; anyone else's are wrapped as data.
 * With an existing session only messages after `sinceTs` are included, since the session already holds the rest.
 */
export function buildPrompt(p: {
  messages: SlackMessage[];
  triggerTs: string;
  sinceTs: string | null;
  botUserId: string;
  hasSession: boolean;
  place?: 'channel' | 'dm';
  now?: Date;
}): string {
  const team = config.allowedUsers;
  const parts: string[] = [];
  const now = (p.now ?? new Date()).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  const where = p.place === 'dm' ? '팀원과의 Slack DM 스레드' : 'Slack 채널 #final_team_charlie의 스레드';
  parts.push(`[상황] 지금 시각은 ${now} (KST)이다. ${where}에서 호출되었다.`);

  const trigger = p.messages.find((m) => m.ts === p.triggerTs);
  const earlier = p.messages.filter((m) => tsNum(m.ts) < tsNum(p.triggerTs) && tsNum(m.ts) > tsNum(p.sinceTs));

  const lines: string[] = [];
  for (const m of earlier) {
    const text = clean(m.text ?? '', p.botUserId);
    const files = m.files?.length ? `\n(첨부 파일 ${m.files.length}개는 아직 읽을 수 없다)` : '';
    if (m.user === p.botUserId) {
      if (!p.hasSession && text) lines.push(`[Rin이 앞서 쓴 글, ${kst(m.ts)}]\n${text}`);
    } else if (!m.bot_id && m.user && team.has(m.user)) {
      lines.push(`[지시] ${displayName(m.user)}, ${kst(m.ts)}\n${text}${files}`);
    } else {
      const who = m.bot_id ? `봇 ${m.bot_id}` : `팀원이 아닌 ${m.user ?? '알 수 없음'}`;
      const data = text.replaceAll('[지시]', '(지시)');
      lines.push(`<<<자료 시작: ${who}의 글, ${kst(m.ts)}>>>\n${data}${files}\n<<<자료 끝>>>`);
    }
  }
  if (lines.length) {
    parts.push(p.hasSession ? '[지난 실행 이후 스레드에 올라온 글]' : '[스레드의 앞선 글]');
    parts.push(lines.join('\n\n'));
  }

  const request = clean(trigger?.text ?? '', p.botUserId).replace(/^@Rin\s*/, '');
  const files = trigger?.files?.length ? `\n(첨부 파일 ${trigger.files.length}개는 아직 읽을 수 없다)` : '';
  parts.push(`[지시] 이번 요청, ${displayName(trigger?.user)}\n${request}${files}`);
  return parts.join('\n\n');
}

/** Prompt for a scheduled run. The result is posted to the team channel as a new message. */
export function buildSchedulePrompt(p: { id: number; title: string; prompt: string; createdBy: string; now?: Date }): string {
  const now = (p.now ?? new Date()).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  return [
    `[상황] 지금 시각은 ${now} (KST)이다. 예약 작업 #${p.id} "${p.title}"이 정해진 시각에 실행되었다. 네 답은 팀 채널 #final_team_charlie 본문에 새 글로 올라간다. 이 실행에서는 PR을 머지하지 않는다.`,
    `[지시] 예약 작업 내용, ${displayName(p.createdBy)}님이 등록\n${p.prompt}`,
  ].join('\n\n');
}
