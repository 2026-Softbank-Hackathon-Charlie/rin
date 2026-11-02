import type { KnownBlock, WebClient } from '@slack/web-api';

/** Global count of live status messages, used to keep total chat.update calls under ~40 per minute. */
let live = 0;
const MIN_INTERVAL_MS = 3000;
const UPDATES_PER_MINUTE = 40;

type Frame = { text: string; blocks: KnownBlock[] };

/** Throttled updater for one status message. Only the newest frame is ever sent. */
export class StatusMessage {
  private pending: Frame | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<unknown> = Promise.resolve();
  private lastSent = 0;
  private closed = false;

  constructor(
    private client: WebClient,
    private channel: string,
    private ts: string,
  ) {
    live++;
  }

  private interval(): number {
    return Math.max(MIN_INTERVAL_MS, (60_000 * Math.max(1, live)) / UPDATES_PER_MINUTE);
  }

  /** Queues a frame; it is sent when the throttle window allows. */
  push(frame: Frame): void {
    if (this.closed) return;
    this.pending = frame;
    if (this.timer) return;
    const wait = Math.max(0, this.lastSent + this.interval() - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sendPending();
    }, wait);
  }

  private sendPending(): void {
    const frame = this.pending;
    if (!frame) return;
    this.pending = undefined;
    this.lastSent = Date.now();
    this.inflight = this.inflight
      .then(() => this.client.chat.update({ channel: this.channel, ts: this.ts, text: frame.text, blocks: frame.blocks }))
      .catch((err) => console.error('status update failed', err?.data?.error ?? err));
  }

  /** Stops throttled updates and sends `frame` right away. */
  async close(frame: Frame): Promise<void> {
    if (!this.closed) live--;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    await this.inflight;
    await this.client.chat.update({ channel: this.channel, ts: this.ts, text: frame.text, blocks: frame.blocks });
  }
}
