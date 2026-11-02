import type { KnownBlock } from '@slack/web-api';
import { escapeSlack } from './text.js';

export const CANCEL_ACTION = 'rin_cancel';

/** Status message: a header line, the log tail in a code block, and a cancel button while live. */
export function statusBlocks(opts: { header: string; log?: string; jobId?: number; cancellable: boolean }): KnownBlock[] {
  const blocks: KnownBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: opts.header } }];
  const log = opts.log?.trim();
  if (log) {
    // Triple backticks inside the log would end the block early.
    const safe = escapeSlack(log).replace(/```/g, "'''");
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + safe + '```' } });
  }
  if (opts.cancellable && opts.jobId !== undefined) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: CANCEL_ACTION,
          style: 'danger',
          text: { type: 'plain_text', text: '취소' },
          value: String(opts.jobId),
        },
      ],
    });
  }
  return blocks;
}
