import crypto from 'node:crypto';
import { githubApp } from '../config.js';

const API = 'https://api.github.com';
const headers = (auth: string) => ({ authorization: auth, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });

function appJwt(appId: string, privateKey: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${body}.${crypto.createSign('RSA-SHA256').update(body).sign(privateKey, 'base64url')}`;
}

let cached: { token: string; expiresAt: number } | undefined;

/**
 * Installation token for the org, or undefined when the GitHub App is not configured.
 * Tokens live one hour; a new one is minted when less than 45 minutes remain, so a run always has time.
 */
export async function installationToken(): Promise<string | undefined> {
  const app = githubApp();
  if (!app) return undefined;
  if (cached && cached.expiresAt - Date.now() > 45 * 60_000) return cached.token;
  const res = await fetch(`${API}/app/installations/${app.installationId}/access_tokens`, {
    method: 'POST',
    headers: headers(`Bearer ${appJwt(app.appId, app.privateKey)}`),
  });
  if (!res.ok) throw new Error(`GitHub App token request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
  return cached.token;
}

export type RepoInfo = { name: string; default_branch: string; archived: boolean };

export async function installationRepos(token: string): Promise<RepoInfo[]> {
  const res = await fetch(`${API}/installation/repositories?per_page=100`, { headers: headers(`token ${token}`) });
  if (!res.ok) throw new Error(`listing repos failed: ${res.status}`);
  const body = (await res.json()) as { repositories: RepoInfo[] };
  return body.repositories.filter((r) => !r.archived);
}

/** State of the PRs whose head is `branch` ('open', 'closed', or undefined when there is none). */
export async function prStateForBranch(token: string, org: string, repo: string, branch: string): Promise<'open' | 'closed' | undefined> {
  const res = await fetch(`${API}/repos/${org}/${repo}/pulls?state=all&head=${org}:${encodeURIComponent(branch)}`, {
    headers: headers(`token ${token}`),
  });
  if (!res.ok) return undefined;
  const pulls = (await res.json()) as { state: 'open' | 'closed' }[];
  if (pulls.length === 0) return undefined;
  return pulls.some((p) => p.state === 'open') ? 'open' : 'closed';
}

let identity: { name: string; email: string } | undefined;

/** Commit author for the App's bot user, e.g. `charlie-rin[bot] <id+charlie-rin[bot]@users.noreply.github.com>`. */
export async function botIdentity(): Promise<{ name: string; email: string } | undefined> {
  if (identity) return identity;
  const app = githubApp();
  if (!app) return undefined;
  const appRes = await fetch(`${API}/app`, { headers: headers(`Bearer ${appJwt(app.appId, app.privateKey)}`) });
  if (!appRes.ok) return undefined;
  const slug = ((await appRes.json()) as { slug: string }).slug;
  const userRes = await fetch(`${API}/users/${encodeURIComponent(`${slug}[bot]`)}`, { headers: { accept: 'application/vnd.github+json' } });
  if (!userRes.ok) return undefined;
  const id = ((await userRes.json()) as { id: number }).id;
  identity = { name: `${slug}[bot]`, email: `${id}+${slug}[bot]@users.noreply.github.com` };
  return identity;
}
