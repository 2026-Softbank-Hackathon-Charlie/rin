import { App, type BlockAction, type ButtonAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config, displayName, healthPort, need } from '../config.js';
import { getSetting, migrate, setSetting, sql, type Job } from '../db/index.js';
import { startHealthServer } from '../health.js';
import { CANCEL_ACTION, statusBlocks } from '../slack/blocks.js';

const app = new App({ token: need('SLACK_BOT_TOKEN'), appToken: need('SLACK_APP_TOKEN'), socketMode: true });
let botUserId = '';
let started = false;

const allowed = (channel: string | undefined, user: string | undefined) =>
  channel === config.channelId && !!user && config.allowedUsers.has(user);

async function reply(client: WebClient, threadTs: string, text: string): Promise<void> {
  await client.chat.postMessage({ channel: config.channelId, thread_ts: threadTs, text });
}

/** `@Rin 모델` shows the model, `@Rin 모델 <id>` switches it for the next runs. Handled without Claude. */
async function handleModel(client: WebClient, threadTs: string, arg: string | undefined): Promise<void> {
  if (!arg) {
    const current = (await getSetting('model')) ?? config.defaultModel;
    await reply(client, threadTs, `지금 모델은 \`${current}\`입니다. 기본값은 \`${config.defaultModel}\`입니다. 바꾸려면 \`@Rin 모델 claude-opus-5-5\`처럼 씁니다.`);
    return;
  }
  if (!/^claude-[a-z0-9-]+$/.test(arg)) {
    await reply(client, threadTs, `모델 이름은 \`claude-\`로 시작해야 합니다: \`${arg}\``);
    return;
  }
  await setSetting('model', arg);
  await reply(client, threadTs, `다음 실행부터 \`${arg}\`를 씁니다.`);
}

app.event('app_mention', async ({ event, client }) => {
  if (!allowed(event.channel, event.user) || event.bot_id) return;
  const text = (event.text ?? '').replaceAll(`<@${botUserId}>`, '').trim();
  const threadTs = event.thread_ts ?? event.ts;

  const model = /^모델(?:\s+(\S+))?\s*$/.exec(text);
  if (model) return handleModel(client, threadTs, model[1]);
  if (!text) return reply(client, threadTs, '할 일을 멘션과 함께 적어 주세요.');

  const [job] = await sql<{ id: number }[]>`
    insert into jobs (kind, channel, thread_ts, trigger_ts, requester, prompt)
    values ('slack', ${event.channel}, ${threadTs}, ${event.ts}, ${event.user!}, ${text})
    on conflict (channel, trigger_ts) where trigger_ts is not null do nothing
    returning id`;
  if (!job) return; // duplicate delivery

  await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {});
  const posted = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: 'Rin 대기 중',
    blocks: statusBlocks({ header: '*Rin* 대기 중', jobId: job.id, cancellable: true }),
  });
  await sql`update jobs set status_ts = ${posted.ts ?? null} where id = ${job.id}`;
});

app.action<BlockAction<ButtonAction>>(CANCEL_ACTION, async ({ ack, body, action, client }) => {
  await ack();
  const user = body.user.id;
  if (!allowed(body.channel?.id, user)) return;
  const jobId = Number(action.value);

  const [queued] = await sql<Job[]>`
    update jobs set status = 'cancelled', cancel_requested_by = ${user}, finished_at = now()
    where id = ${jobId} and status = 'queued' returning *`;
  if (queued?.status_ts) {
    const header = `*Rin* 취소됨 | ${displayName(user)}님이 취소`;
    await client.chat.update({ channel: queued.channel, ts: queued.status_ts, text: header.replace(/\*/g, ''), blocks: statusBlocks({ header, cancellable: false }) });
    return;
  }
  // A running job is stopped by the worker, which polls this column every second.
  await sql`update jobs set cancel_requested_by = ${user}
            where id = ${jobId} and status = 'running' and cancel_requested_by is null`;
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
  console.log(`gateway ready: channel ${config.channelId}, ${config.allowedUsers.size} allowed users`);
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
