const BASE = 'https://api.cloudflare.com/client/v4/';
const MAX_CHARS = 30_000;

/** A GET URL under the v4 API, or a message saying why the path is refused. */
export function apiUrl(path: string, query?: Record<string, string>): URL | string {
  const rel = path.trim().replace(/^\/+/, '').replace(/^client\/v4\//, '');
  if (!rel || /[?#\\]|:\/\//.test(rel)) return `쓸 수 없는 경로다: ${path}. 쿼리는 query로 따로 준다.`;
  const url = new URL(rel, BASE);
  if (url.origin !== 'https://api.cloudflare.com' || !url.pathname.startsWith('/client/v4/')) return `v4 API 밖의 경로다: ${path}`;
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

/** The analytics GraphQL API has no mutations; refuse them anyway so the tool stays read-only by itself. */
export function graphqlRefusal(query: string): string | undefined {
  return /\bmutation\b/i.test(query) ? 'GraphQL mutation은 쓸 수 없다. 이 도구는 읽기 전용이다.' : undefined;
}

async function call(token: string, url: URL, init: RequestInit = {}): Promise<string> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    const cut = body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS)}\n(${body.length}자 중 앞 ${MAX_CHARS}자만 보였다. per_page나 필터로 줄인다)` : body;
    return `HTTP ${res.status}\n${cut}`;
  } catch (err) {
    return `호출하지 못했다: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function cloudflareGet(token: string, url: URL): Promise<string> {
  return call(token, url);
}

export function cloudflareGraphql(token: string, query: string, variables?: Record<string, unknown>): Promise<string> {
  return call(token, new URL('graphql', BASE), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
}
