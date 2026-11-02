import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

/** Directory that holds package.json, prompts/ and workspace-template/ (works from src/ and dist/). */
export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function need(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

/** Slack user IDs of the five team members. Not secrets. */
export const TEAM: Record<string, string> = {
  U0C4A1HL3EH: '김동윤',
  U0C4D0R3XJS: '박준석',
  U0C4J144FEH: '강종욱',
  U0C4K3UE58U: '조서현',
  U0C4QG4TRAS: '이태훈',
};

const allowed = (env.RIN_ALLOWED_USERS ?? Object.keys(TEAM).join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  channelId: env.RIN_CHANNEL_ID ?? 'C0CCZ9RJ52T',
  allowedUsers: new Set(allowed),
  defaultModel: env.RIN_MODEL ?? 'claude-sonnet-5-5',
  workspaceDir: path.resolve(env.RIN_WORKSPACE ?? '/data/workspace'),
  claudeConfigDir: path.resolve(env.RIN_CLAUDE_CONFIG_DIR ?? '/data/claude'),
  concurrency: int('RIN_CONCURRENCY', 4),
  logTailChars: int('RIN_LOG_TAIL_CHARS', 1500),
  maxTurns: int('RIN_MAX_TURNS', 150),
  maxBudgetUsd: int('RIN_MAX_BUDGET_USD', 5),
  drainMs: int('RIN_DRAIN_MS', 240_000),
};

export function healthPort(role: 'gateway' | 'worker'): number {
  return int('RIN_HEALTH_PORT', role === 'gateway' ? 8081 : 8080);
}

export function displayName(userId: string | undefined): string {
  if (!userId) return '알 수 없음';
  return TEAM[userId] ?? userId;
}
