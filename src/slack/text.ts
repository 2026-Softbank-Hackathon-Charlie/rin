/** Escapes the three characters Slack treats as markup in message text. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

const FENCE = /^\s*```(.*)$/;

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** The longest prefix of `s` within `max` UTF-8 bytes, never splitting a character, and at least one character. */
function prefixWithin(s: string, max: number): string {
  let used = 0;
  let end = 0;
  for (const ch of s) {
    const b = bytes(ch);
    if (used + b > max && end > 0) break;
    used += b;
    end += ch.length;
  }
  return s.slice(0, end);
}

/**
 * Splits text into chunks of at most `limit` UTF-8 bytes, preferring line breaks.
 * Slack's chat.update rejects text over 4,000 bytes (msg_too_long), and a Korean
 * character takes three, so the limit is in bytes, not characters.
 * A code block cut by a split is closed at the end of one chunk and reopened
 * (with the same language tag) at the start of the next.
 */
export function splitMessage(text: string, limit = 3900): string[] {
  const out: string[] = [];
  let fence: string | null = null; // language tag of the open code block, '' when untagged
  const opening = () => (fence !== null ? '```' + fence : '');
  const closing = () => (fence !== null ? '\n```' : '');
  let cur = '';

  const flush = () => {
    out.push(cur + closing());
    cur = opening();
  };

  for (const original of text.split('\n')) {
    let line = original;
    for (;;) {
      const sep = cur === '' ? '' : '\n';
      const room = limit - bytes(cur) - bytes(sep) - bytes(closing());
      if (bytes(line) <= room) {
        cur += sep + line;
        break;
      }
      if (cur !== opening()) {
        flush(); // start a fresh chunk and try again
        continue;
      }
      // The line alone does not fit an empty chunk: cut it hard.
      const take = prefixWithin(line, room);
      cur += sep + take;
      line = line.slice(take.length);
      flush();
    }
    const m = FENCE.exec(original);
    if (m) fence = fence === null ? m[1]!.trim() : null;
  }
  if (cur.trim() !== '' && cur !== opening()) out.push(cur);
  return out;
}

/** Keeps the last `max` characters, starting at a line boundary when one is near. */
export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const nl = cut.indexOf('\n');
  return nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut;
}
