import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { formatBytes } from '../slack/text.js';
import type { SlackMessage } from './thread.js';

/** The fields Rin uses of a file attached to a Slack message (conversations.replies). */
export type SlackFile = { id?: string; name?: string; mimetype?: string; size?: number; url_private_download?: string };

/** What the prompt says about one attached file: where it was saved, or why it was not. */
export type Attachment = { name: string; mimetype: string; size: number; path?: string; error?: string };

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_NEW_FILES = 10;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 3600_000;

export const attachmentsRoot = () => path.join(config.workspaceDir, 'attachments');

/** Folder of one conversation: files received from Slack and files made to upload. */
export function threadDir(threadTs: string): string {
  return path.join(attachmentsRoot(), threadTs.replace(/[^0-9.]/g, '_'));
}

/** File name on disk: the Slack file id plus the original name without directories or awkward characters. */
export function safeName(id: string, name: string | undefined): string {
  const base = path.posix
    .basename((name ?? '').replace(/\\/g, '/'))
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_');
  return `${id}-${(base || 'file').slice(-120)}`;
}

async function download(token: string, url: string, target: string, mimetype: string): Promise<{ path: string } | { error: string }> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    // Without files:read Slack answers with its login page instead of the file.
    if (res.headers.get('content-type')?.startsWith('text/html') && !mimetype.startsWith('text/html')) {
      return { error: 'Slack이 파일 대신 로그인 페이지를 돌려줬다(files:read 권한 확인 필요)' };
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_FILE_BYTES) return { error: `${formatBytes(MAX_FILE_BYTES)}보다 크다` };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.part`, body);
    fs.renameSync(`${target}.part`, target);
    return { path: target };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Saves the files attached to `messages` into `dir`, newest message first, keyed by Slack file id.
 * Files already on disk are reused, so a thread's files are fetched once; at most MAX_NEW_FILES per call.
 */
export async function fetchAttachments(token: string, dir: string, messages: SlackMessage[]): Promise<Map<string, Attachment>> {
  const out = new Map<string, Attachment>();
  let fetched = 0;
  for (const m of [...messages].reverse()) {
    for (const f of (m.files ?? []) as SlackFile[]) {
      if (!f?.id || out.has(f.id)) continue;
      const info = { name: f.name ?? f.id, mimetype: f.mimetype ?? 'application/octet-stream', size: f.size ?? 0 };
      const target = path.join(dir, safeName(f.id, f.name));
      if (fs.existsSync(target)) {
        out.set(f.id, { ...info, path: target });
        continue;
      }
      const skip = !f.url_private_download
        ? '내려받을 주소가 없다'
        : info.size > MAX_FILE_BYTES
          ? `${formatBytes(MAX_FILE_BYTES)}보다 크다`
          : fetched >= MAX_NEW_FILES
            ? `한 번에 ${MAX_NEW_FILES}개까지만 받는다`
            : undefined;
      if (skip) {
        out.set(f.id, { ...info, error: skip });
        continue;
      }
      fetched++;
      out.set(f.id, { ...info, ...(await download(token, f.url_private_download!, target, info.mimetype)) });
    }
  }
  return out;
}

/** Names that usually hold secrets. The team channel is read by organizers and mentors too. */
function looksSecret(name: string): boolean {
  return (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) || /\.(pem|key)$|^id_(rsa|ecdsa|ed25519)$/.test(name);
}

/** Checks a file Claude asks to upload: it must be a regular file inside the workspace, small enough and not a secret. */
export function uploadable(file: string, workspaceDir: string): { path: string } | string {
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(workspaceDir, file));
  } catch {
    return `파일이 없다: ${file}`;
  }
  const rel = path.relative(fs.realpathSync(workspaceDir), real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return `작업 공간(${workspaceDir}) 밖의 파일은 올리지 않는다`;
  const stat = fs.statSync(real);
  if (!stat.isFile()) return `일반 파일이 아니다: ${file}`;
  if (stat.size > MAX_UPLOAD_BYTES) return `${formatBytes(MAX_UPLOAD_BYTES)}보다 크다`;
  if (looksSecret(path.basename(real))) return '비밀값이 들어 있을 수 있는 파일이다';
  return { path: real };
}

/** Removes conversation folders that have not changed for seven days. */
export async function cleanupAttachments(): Promise<void> {
  const root = attachmentsRoot();
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const dir = path.join(root, entry.name);
    if (Date.now() - fs.statSync(dir).mtimeMs < KEEP_MS) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`removed attachments ${dir} (unchanged for 7 days)`);
  }
}
