import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { buildOptions } from '../src/agent/options.js';

test('the Bash policy also guards Monitor, which runs shell commands', async () => {
  process.env.ANTHROPIC_API_KEY ??= 'test';
  const options = buildOptions({
    model: 'claude-test',
    abortController: new AbortController(),
    guard: { mergeAllowed: false, request: '', scheduled: false },
  });
  const entry = options.hooks?.PreToolUse?.find((m) => m.matcher && new RegExp(`^(?:${m.matcher})$`).test('Monitor'));
  assert.ok(entry, 'no PreToolUse hook matches Monitor');
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_input: { command: 'charlie plan approve pln_1' } };
  const out = await entry.hooks[0]!(input as unknown as HookInput, undefined, { signal: new AbortController().signal });
  assert.equal((out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, 'deny');
});
