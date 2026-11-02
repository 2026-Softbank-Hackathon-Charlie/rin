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
  {
    id: 2,
    sql: `
      -- Worktrees made for write work; a thread keeps using its worktree for the same repo.
      create table worktrees (
        id serial primary key,
        thread_ts text not null,
        repo text not null,
        path text not null unique,
        branch text not null,
        created_at timestamptz not null default now(),
        last_used_at timestamptz not null default now(),
        unique (thread_ts, repo)
      );

      create table schedules (
        id serial primary key,
        title text not null,
        cron text not null,
        prompt text not null,
        created_by text not null,
        enabled boolean not null default true,
        next_run_at timestamptz not null,
        last_run_at timestamptz,
        fail_streak int not null default 0,
        created_at timestamptz not null default now()
      );

      alter table jobs add column schedule_id int references schedules (id) on delete set null;
      alter table threads drop column worktree_path;
      alter table threads drop column branch;
    `,
  },
];
