import fs from 'node:fs';
import path from 'node:path';
import type { HookCallback, HookJSONOutput, Options } from '@anthropic-ai/claude-agent-sdk';
import { appRoot, config, need } from '../config.js';
import { checkBash, checkWritePath, type Verdict } from './guards.js';

/** Tools that make no sense without a human at a terminal, or that only live as long as the session. */
const DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'AskUserQuestion',
  'EnterPlanMode',
  'mcp__notion__notion-delete-pages',
  'mcp__notion__notion-move-pages',
  'mcp__notion__notion-delete-databases',
];

/** Variables passed through to the Claude Code process. The SDK `env` option replaces the whole environment. */
const PASS_THROUGH = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'PATHEXT', 'ComSpec', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'LANG'];

let cachedPrompt: string | undefined;
function systemAppend(): string {
  cachedPrompt ??= fs.readFileSync(path.join(appRoot, 'prompts', 'rin.md'), 'utf8');
  return cachedPrompt;
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.ANTHROPIC_API_KEY = need('ANTHROPIC_API_KEY');
  env.CLAUDE_CONFIG_DIR = config.claudeConfigDir;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'rin/0.1';
  env.TZ = 'Asia/Seoul';
  return env;
}

function toHookOutput(v: Verdict): HookJSONOutput {
  if (v.allow) return {};
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: v.reason },
  };
}

export function buildOptions(p: {
  model: string;
  resume?: string;
  abortController: AbortController;
  mergeAllowed: boolean;
  stderr?: (data: string) => void;
}): Options {
  const bashHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const command = (input.tool_input as { command?: unknown } | null)?.command;
    return toHookOutput(checkBash(typeof command === 'string' ? command : '', { mergeAllowed: p.mergeAllowed }));
  };
  const writeHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const toolInput = (input.tool_input ?? {}) as { file_path?: unknown; notebook_path?: unknown };
    const target = typeof toolInput.file_path === 'string' ? toolInput.file_path : toolInput.notebook_path;
    return toHookOutput(checkWritePath(typeof target === 'string' ? target : undefined, config.workspaceDir));
  };

  return {
    cwd: config.workspaceDir,
    model: p.model,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['user', 'project'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend() },
    resume: p.resume,
    abortController: p.abortController,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    disallowedTools: DISALLOWED_TOOLS,
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [bashHook] },
        { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [writeHook] },
      ],
    },
    env: childEnv(),
    stderr: p.stderr,
  };
}
