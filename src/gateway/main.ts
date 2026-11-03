import { App, type BlockAction, type ButtonAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config, displayName, healthPort, need } from '../config.js';
import { getSetting, migrate, setSetting, sql, type Job } from '../db/index.js';
import { startHealthServer } from '../health.js';
import { CANCEL_ACTION, statusBlocks } from '../slack/blocks.js';

const app = new App({ token: need('SLACK_BOT_TOKEN'), appToken: need('SLACK_APP_TOKEN'), socketMode: true });
let botUserId = '';
let started = false;

const isTeam = (user: string | undefined): user is string => !!user && config.allowedUsers.has(user);
/** Rin answers in the team channel and in DMs (channel IDs starting with D). */
const isRinChannel = (channel: string | undefined) => channel === config.channelId || !!channel?.startsWith('D');

async function reply(client: WebClient, channel: string, threadTs: string, text: string): Promise<void> {
  await client.chat.postMessage({ channel, thread_ts: threadTs, text });
}

/** `@Rin 모델` shows the model, `@Rin 모델 <id>` switches it for the next runs. Handled without Claude. */
async function handleModel(client: WebClient, channel: string, threadTs: string, arg: string | undefined): Promise<void> {
  if (!arg) {
    const current = (await getSetting('model')) ?? config.defaultModel;
    await reply(client, channel, threadTs, `지금 모델은 \`${current}\`입니다. 기본값은 \`${config.defaultModel}\`입니다. 바꾸려면 \`@Rin 모델 claude-sonnet-5-5\`처럼 씁니다.`);
    return;
  }
  if (!/^claude-[a-z0-9-]+$/.test(arg)) {
    await reply(client, channel, threadTs, `모델 이름은 \`claude-\`로 시작해야 합니다: \`${arg}\``);
    return;
  }
  await setSetting('model', arg);
  await reply(client, channel, threadTs, `다음 실행부터 \`${arg}\`를 씁니다.`);
}

/** Common path for a channel mention and a DM: commands, then a queued job with a status message in the thread. */
async function accept(client: WebClient, m: { channel: string; ts: string; thread_ts?: string; user: string; text?: string }): Promise<void> {
  const text = (m.text ?? '').replaceAll(`<@${botUserId}>`, '').trim();
  const threadTs = m.thread_ts ?? m.ts;

  const model = /^모델(?:\s+(\S+))?\s*$/.exec(text);
  if (model) return handleModel(client, m.channel, threadTs, model[1]);
  if (!text) return reply(client, m.channel, threadTs, '할 일을 함께 적어 주세요.');

  const [job] = await sql<{ id: number }[]>`
    insert into jobs (kind, channel, thread_ts, trigger_ts, requester, prompt)
    values ('slack', ${m.channel}, ${threadTs}, ${m.ts}, ${m.user}, ${text})
    on conflict (channel, trigger_ts) where trigger_ts is not null do nothing
    returning id`;
  if (!job) return; // duplicate delivery

  await client.reactions.add({ channel: m.channel, timestamp: m.ts, name: 'eyes' }).catch(() => {});
  const posted = await client.chat.postMessage({
    channel: m.channel,
    thread_ts: threadTs,
    text: 'Rin 대기 중',
    blocks: statusBlocks({ header: '*Rin* 대기 중', jobId: job.id, cancellable: true }),
  });
  await sql`update jobs set status_ts = ${posted.ts ?? null} where id = ${job.id}`;
}

// Team channel: Rin works only when mentioned, also inside threads.
app.event('app_mention', async ({ event, client }) => {
  if (event.channel !== config.channelId || !isTeam(event.user) || event.bot_id) return;
  await accept(client, { channel: event.channel, ts: event.ts, thread_ts: event.thread_ts, user: event.user, text: event.text });
});

// DMs: every message is for Rin, no mention needed. A new DM starts a thread; replies in that thread continue it.
app.message(async ({ message, client }) => {
  if (message.channel_type !== 'im') return;
  if (message.subtype !== undefined && message.subtype !== 'file_share') return;
  const m = message as { channel: string; ts: string; thread_ts?: string; user?: string; bot_id?: string; text?: string };
  if (!isTeam(m.user) || m.bot_id) return;
  await accept(client, { channel: m.channel, ts: m.ts, thread_ts: m.thread_ts, user: m.user, text: m.text });
});

app.action<BlockAction<ButtonAction>>(CANCEL_ACTION, async ({ ack, body, action, client }) => {
  await ack();
  const user = body.user.id;
  const channel = body.channel?.id;
  if (!isTeam(user) || !isRinChannel(channel)) return;
  const jobId = Number(action.value);

  const [queued] = await sql<Job[]>`
    update jobs set status = 'cancelled', cancel_requested_by = ${user}, finished_at = now()
    where id = ${jobId} and channel = ${channel!} and status = 'queued' returning *`;
  if (queued?.status_ts) {
    const header = `*Rin* 취소됨 | ${displayName(user)}님이 취소`;
    await client.chat.update({ channel: queued.channel, ts: queued.status_ts, text: header.replace(/\*/g, ''), blocks: statusBlocks({ header, cancellable: false }) });
    return;
  }
  // A running job is stopped by the worker, which polls this column every second.
  await sql`update jobs set cancel_requested_by = ${user}
            where id = ${jobId} and channel = ${channel!} and status = 'running' and cancel_requested_by is null`;
});

app.error(async (err) => {
  console.error('bolt error', err);
});

async function main(): Promise<void> {
  await migrate();
  botUserId = (await app.client.auth.test()).user_id ?? '';
  startHealthServer(healthPort('gateway'), () => started);
  await app.start();
  started = true;
  console.log(`gateway ready: channel ${config.channelId} and DMs, ${config.allowedUsers.size} allowed users`);
  const stop = async () => {
    started = false;
    await app.stop().catch(() => {});
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((err) => {
  console.error('gateway failed to start', err);
  process.exit(1);
});
