import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};

function describeTool(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  switch (name) {
    case 'Bash':
      return `${name}: ${oneLine(str('command'), 200)}`;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${name}: ${str('file_path') || str('notebook_path')}`;
    case 'Grep':
    case 'Glob':
      return `${name}: ${oneLine(str('pattern'), 120)}`;
    case 'WebFetch':
      return `${name}: ${str('url')}`;
    case 'WebSearch':
      return `${name}: ${oneLine(str('query'), 120)}`;
    case 'Agent':
    case 'Task':
      return `${name}: ${oneLine(str('description'), 120)}`;
    case 'Skill':
      return `${name}: ${str('skill') || str('name')}`;
    default:
      return name;
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : ''))
      .join('\n');
  }
  return '';
}

/** Turns one SDK message into terminal-like log lines. Returns the number of tool calls it contained. */
export function logLines(message: SDKMessage): { lines: string[]; toolCalls: number } {
  const lines: string[] = [];
  let toolCalls = 0;
  if (message.type === 'assistant' && message.parent_tool_use_id === null) {
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text.trim()) {
        lines.push(oneLine(block.text, 600));
      } else if (block.type === 'tool_use') {
        toolCalls++;
        lines.push(`● ${describeTool(block.name, (block.input ?? {}) as Record<string, unknown>)}`);
      }
    }
  } else if (message.type === 'user' && message.parent_tool_use_id === null && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue;
      const text = resultText(block.content).trim();
      const all = text.split('\n');
      const first = oneLine(all[0] ?? '', 160);
      const more = all.length > 1 ? ` (+${all.length - 1}줄)` : '';
      lines.push(`  ⎿ ${block.is_error ? '오류: ' : ''}${first || '(출력 없음)'}${more}`);
    }
  }
  return { lines, toolCalls };
}
