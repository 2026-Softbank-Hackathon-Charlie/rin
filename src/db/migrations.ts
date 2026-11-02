export const migrations: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      create table jobs (
        id serial primary key,
        kind text not null check (kind in ('slack', 'schedule')),
        channel text not null,
        thread_ts text,
        trigger_ts text,
        requester text,
        prompt text not null,
        status text not null default 'queued'
          check (status in ('queued', 'running', 'done', 'failed', 'cancelled', 'interrupted')),
        status_ts text,
        cancel_requested_by text,
        cost_usd numeric(10, 4),
        error text,
        created_at timestamptz not null default now(),
        started_at timestamptz,
        finished_at timestamptz
      );
      create index jobs_status_idx on jobs (status, id);
      -- Slack may deliver the same mention twice; one message makes one job.
      create unique index jobs_trigger_uniq on jobs (channel, trigger_ts) where trigger_ts is not null;

      create table threads (
        thread_ts text primary key,
        channel text not null,
        session_id text,
        worktree_path text,
        branch text,
        last_read_ts text,
        updated_at timestamptz not null default now()
      );

      create table settings (
        key text primary key,
        value text not null,
        updated_at timestamptz not null default now()
      );
    `,
  },
];
