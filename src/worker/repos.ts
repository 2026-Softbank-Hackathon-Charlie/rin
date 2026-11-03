import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config, GITHUB_ORG } from '../config.js';
import { sql, type WorktreeRow } from '../db/index.js';
import { installationRepos, installationToken, prStateForBranch, type RepoInfo } from '../github/app.js';

const run = promisify(execFile);

/** Credential helper that answers with the installation token from $GH_TOKEN, so tokens never land in .git/config. */
const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

async function git(args: string[], token: string, cwd?: string): Promise<string> {
  const { stdout } = await run('git', ['-c', `credential.helper=${CREDENTIAL_HELPER}`, ...args], {
    cwd,
    env: { ...process.env, GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

const reposDir = () => path.join(config.workspaceDir, 'repos');
const worktreesDir = () => path.join(config.workspaceDir, 'worktrees');

/**
 * Serialises git operations on one clone across every worker process (old and new overlap during a
 * handoff deploy), because git takes locks on the shared .git directory. Uses a Postgres advisory lock
 * held for the duration of `fn`.
 */
async function withLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`rin-repo:${repo}`}))`;
    return { value: await fn() };
  });
  return (result as { value: T }).value;
}

let known: RepoInfo[] = [];
let lastSync = 0;

/** Clones missing repos and moves every clone under repos/ to the latest default branch. */
export async function syncRepos(force = false): Promise<void> {
  if (!force && Date.now() - lastSync < 60_000) return;
  const token = await installationToken();
  if (!token) return;
  lastSync = Date.now();
  known = await installationRepos(token);
  fs.mkdirSync(reposDir(), { recursive: true });
  // One repo at a time: each holds a database connection for its lock.
  for (const repo of known) {
    await withLock(repo.name, async () => {
      const dir = path.join(reposDir(), repo.name);
      try {
        if (!fs.existsSync(path.join(dir, '.git'))) {
          await git(['clone', '--quiet', `https://github.com/${GITHUB_ORG}/${repo.name}.git`, dir], token);
        } else {
          await git(['fetch', '--quiet', '--prune', 'origin'], token, dir);
          await git(['checkout', '--quiet', '-f', '-B', repo.default_branch, `origin/${repo.default_branch}`], token, dir);
          await git(['clean', '-fdq'], token, dir);
        }
      } catch (err) {
        console.error(`repo sync failed for ${repo.name}`, err instanceof Error ? err.message : err);
      }
    });
  }
}

export function knownRepos(): string[] {
  return known.map((r) => r.name);
}

/** A worktree made as its own clone. Older ones were `git worktree add` checkouts whose .git is a file. */
function isOwnClone(dir: string): boolean {
  try {
    return fs.lstatSync(path.join(dir, '.git')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Deletes a worktree folder and its row. The worker never runs git inside it: Claude has written there.
 * Worktrees from before the sandbox also left metadata and a branch in the clone under repos/.
 */
async function removeWorktree(row: WorktreeRow, token: string | undefined): Promise<void> {
  fs.rmSync(row.path, { recursive: true, force: true });
  if (token) {
    await withLock(row.repo, async () => {
      const clone = path.join(reposDir(), row.repo);
      await git(['worktree', 'prune'], token, clone).catch(() => {});
      await git(['branch', '-D', row.branch], token, clone).catch(() => {});
    });
  }
  await sql`delete from worktrees where id = ${row.id}`;
}

/**
 * Returns the worktree a thread uses for `repo`, creating it on a new rin/<id> branch from the default branch.
 * One thread keeps one worktree per repo, so follow-up requests continue on the same branch.
 *
 * The worktree is a separate clone, not `git worktree add`: a linked worktree writes into the clone's .git,
 * and the sandbox mounts repos/ read only.
 */
export async function ensureWorktree(threadTs: string, repo: string): Promise<{ path: string; branch: string; base: string; created: boolean }> {
  await syncRepos();
  const info = known.find((r) => r.name === repo);
  if (!info) throw new Error(`${repo} 레포를 찾을 수 없다. 쓸 수 있는 레포: ${knownRepos().join(', ')}`);

  const token = await installationToken();
  const existing = (await sql<WorktreeRow[]>`select * from worktrees where thread_ts = ${threadTs} and repo = ${repo}`)[0];
  if (existing && isOwnClone(existing.path)) {
    await sql`update worktrees set last_used_at = now() where id = ${existing.id}`;
    return { path: existing.path, branch: existing.branch, base: info.default_branch, created: false };
  }
  if (existing) await removeWorktree(existing, token);

  if (!token) throw new Error('GitHub App이 설정되지 않았다');
  const id = crypto.randomBytes(3).toString('hex');
  const branch = `rin/${id}`;
  const dir = path.join(worktreesDir(), `${repo}-${id}`);
  fs.mkdirSync(worktreesDir(), { recursive: true });
  // No hardlinks: the objects of the new clone must not be the same files as those of the read-only clone.
  await withLock(repo, () => git(['clone', '--quiet', '--no-hardlinks', path.join(reposDir(), repo), dir], token));
  await git(['remote', 'set-url', 'origin', `https://github.com/${GITHUB_ORG}/${repo}.git`], token, dir);
  await git(['fetch', '--quiet', 'origin', info.default_branch], token, dir);
  await git(['checkout', '--quiet', '-b', branch, `origin/${info.default_branch}`], token, dir);
  await sql`insert into worktrees (thread_ts, repo, path, branch) values (${threadTs}, ${repo}, ${dir}, ${branch})`;
  return { path: dir, branch, base: info.default_branch, created: true };
}

/** Removes worktrees whose PR is merged or closed, or that were not used for three days. */
export async function cleanupWorktrees(): Promise<void> {
  const token = await installationToken();
  if (!token) return;
  const rows = await sql<WorktreeRow[]>`select * from worktrees`;
  for (const row of rows) {
    const stale = Date.now() - row.last_used_at.getTime() > 3 * 24 * 3600_000;
    const pr = await prStateForBranch(token, GITHUB_ORG, row.repo, row.branch).catch(() => undefined);
    if (!stale && pr !== 'closed') continue;
    await removeWorktree(row, token);
    console.log(`removed worktree ${row.path} (${stale ? 'unused for 3 days' : 'PR closed'})`);
  }
}
