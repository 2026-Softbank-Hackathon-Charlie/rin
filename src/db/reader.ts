import { createHmac } from 'node:crypto';
import { need } from '../config.js';
import { sql } from './index.js';

/** Read-only login role for `psql` in Claude's Bash. Migration 5 creates it and grants SELECT on Rin's tables. */
export const READER_ROLE = 'rin_reader';

function mainUrl(): URL {
  return new URL(need('DATABASE_URL'));
}

/** Derived from the main password, so old and new workers in a handoff deploy agree on it. */
function readerPassword(url: URL): string {
  return createHmac('sha256', decodeURIComponent(url.password)).update(READER_ROLE).digest('hex');
}

/** Sets the reader's password. Called by the worker at start, after migrations. */
export async function ensureReader(): Promise<void> {
  // ALTER ROLE takes no bind parameters; the password is hex, so inlining it is safe.
  await sql.unsafe(`alter role ${READER_ROLE} password '${readerPassword(mainUrl())}'`);
}

/** libpq variables that make a bare `psql` connect to Rin's database as the reader. */
export function readerEnv(): Record<string, string> {
  const url = mainUrl();
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: READER_ROLE,
    PGPASSWORD: readerPassword(url),
  };
}
