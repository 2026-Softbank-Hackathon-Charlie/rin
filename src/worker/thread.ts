import type { WebClient } from '@slack/web-api';
import { config, displayName } from '../config.js';
import { formatBytes } from '../slack/text.js';
import type { Attachment } from './attachments.js';

export type SlackMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: { id?: string; name?: string }[];
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

const defang = (s: string) => s.replace(/<<<|>>>/g, (m) => (m === '<<<' ? '‹‹‹' : '›››'));

/** Rewrites mentions to readable names and neutralises the data-fence markers. */
export function clean(text: string, botUserId: string): string {
  return defang(
    text.replaceAll(`<@${botUserId}>`, '@Rin').replace(/<@([A-Z0-9]+)>/g, (_m, id: string) => `@${displayName(id)}`),
  ).trim();
}

/** Lists a message's attached files with the path the worker saved each to, or why it could not. */
function fileLines(m: SlackMessage, attachments: Map<string, Attachment> | undefined): string {
  const files = m.files ?? [];
  if (!files.length) return '';
  const lines = files.map((f) => {
    const a = f.id ? attachments?.get(f.id) : undefined;
    const name = defang((a?.name ?? f.name ?? '이름 없는 파일').replace(/\s+/g, ' ')).replaceAll('[지시]', '(지시)');
    if (!a) return `- ${name}: 받지 않았다`;
    const head = `- ${name} (${a.mimetype}, ${formatBytes(a.size)})`;
    return a.path ? `${head}: ${a.path}` : `${head}: 받지 못했다, ${a.error}`;
  });
  return `\n(첨부 파일 ${files.length}개)\n${lines.join('\n')}`;
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
  /** The previous run of this same request was cut off by a redeploy and is being resumed. */
  resuming?: boolean;
  /** Files of the thread already saved by the worker, by Slack file id. */
  attachments?: Map<string, Attachment>;
  /** Folder of this conversation for received files and files to upload. */
  filesDir?: string;
  now?: Date;
}): string {
  const team = config.allowedUsers;
  const parts: string[] = [];
  const now = (p.now ?? new Date()).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  const where = p.place === 'dm' ? '팀원과의 Slack DM 스레드' : 'Slack 채널 #final_team_charlie의 스레드';
  const folder = p.filesDir ? ` 이 대화의 파일 폴더는 ${p.filesDir}이다.` : '';
  parts.push(`[상황] 지금 시각은 ${now} (KST)이다. ${where}에서 호출되었다.${folder}`);

  const trigger = p.messages.find((m) => m.ts === p.triggerTs);
  const earlier = p.messages.filter((m) => tsNum(m.ts) < tsNum(p.triggerTs) && tsNum(m.ts) > tsNum(p.sinceTs));

  const lines: string[] = [];
  for (const m of earlier) {
    const text = clean(m.text ?? '', p.botUserId);
    const files = fileLines(m, p.attachments);
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
  const files = trigger ? fileLines(trigger, p.attachments) : '';
  if (p.resuming) {
    parts.push(
      `[지시] 재배포로 이 요청의 앞선 실행이 중간에 멈췄다. 아래 요청을 이어서 마무리한다. 이미 끝낸 일(커밋, push, PR, 메시지, 예약 등록)은 반복하지 말고, 대화 기록과 실제 상태(git, PR 목록)를 확인해 남은 일만 한다.\n요청자: ${displayName(trigger?.user)}\n${request}${files}`,
    );
  } else {
    parts.push(`[지시] 이번 요청, ${displayName(trigger?.user)}\n${request}${files}`);
  }
  return parts.join('\n\n');
}

/** Prompt for a scheduled run. The result is posted to the team channel as a new message. */
export function buildSchedulePrompt(p: {
  id: number;
  title: string;
  prompt: string;
  createdBy: string;
  announce?: boolean;
  now?: Date;
}): string {
  const now = (p.now ?? new Date()).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  const where =
    p.announce === false
      ? '네 답은 Slack 어디에도 올라가지 않고 작업 기록에만 남으니, 한 일을 한 줄로만 적는다. 실패하면 등록자에게 DM으로 알려진다.'
      : '네 답은 팀 채널 #final_team_charlie 본문에 새 글로 올라간다.';
  return [
    `[상황] 지금 시각은 ${now} (KST)이다. 예약 작업 #${p.id} "${p.title}"이 정해진 시각에 실행되었다. ${where} 이 실행에서는 PR을 머지하지 않는다.`,
    `[지시] 예약 작업 내용, ${displayName(p.createdBy)}님이 등록\n${p.prompt}`,
  ].join('\n\n');
}
