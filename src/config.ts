import fs from 'node:fs';
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
  /** Claude runs at once across all workers; old and new workers share it during a handoff deploy. */
  concurrency: int('RIN_CONCURRENCY', 4),
  logTailChars: int('RIN_LOG_TAIL_CHARS', 1500),
  maxTurns: int('RIN_MAX_TURNS', 150),
  maxBudgetUsd: int('RIN_MAX_BUDGET_USD', 5),
  /** How long a worker told to stop keeps finishing its jobs. Unfinished jobs are then queued to resume. */
  drainMs: int('RIN_DRAIN_MS', 2 * 3600_000),
  /** Short commit of the running image; set by deploy.sh. */
  version: env.RIN_VERSION ?? 'dev',
};

export const GITHUB_ORG = env.RIN_GITHUB_ORG ?? '2026-Softbank-Hackathon-Charlie';

/** GitHub App credentials, or undefined when not configured (GitHub features are then off). */
export function githubApp(): { appId: string; installationId: string; privateKey: string } | undefined {
  const appId = env.GITHUB_APP_ID;
  const installationId = env.GITHUB_APP_INSTALLATION_ID;
  let privateKey: string | undefined;
  if (env.GITHUB_APP_PRIVATE_KEY_B64) privateKey = Buffer.from(env.GITHUB_APP_PRIVATE_KEY_B64, 'base64').toString('utf8');
  else if (env.GITHUB_APP_PRIVATE_KEY_PATH) privateKey = fs.readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
  if (!appId || !installationId || !privateKey) return undefined;
  return { appId, installationId, privateKey };
}

/** View-only AWS identity handed to Claude (IAM user rin-ai). Never used by Rin itself. */
export function aiAwsEnv(): Record<string, string> {
  const id = env.RIN_AI_AWS_ACCESS_KEY_ID;
  const secret = env.RIN_AI_AWS_SECRET_ACCESS_KEY;
  if (!id || !secret) return {};
  return { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, AWS_REGION: 'ap-northeast-2', AWS_DEFAULT_REGION: 'ap-northeast-2' };
}

export function healthPort(role: 'gateway' | 'worker'): number {
  return int('RIN_HEALTH_PORT', role === 'gateway' ? 8081 : 8080);
}

export function displayName(userId: string | undefined): string {
  if (!userId) return '알 수 없음';
  return TEAM[userId] ?? userId;
}

/** Resolves a team member from a Slack ID, `<@ID>` mention or Korean name (with or without 님). */
export function resolveTeamMember(who: string): string | undefined {
  const s = who.trim().replace(/^<@([A-Z0-9]+)(\|[^>]*)?>$/, '$1').replace(/님$/, '');
  if (config.allowedUsers.has(s)) return s;
  const byName = Object.entries(TEAM).find(([, name]) => name === s || name.slice(1) === s);
  return byName && config.allowedUsers.has(byName[0]) ? byName[0] : undefined;
}
