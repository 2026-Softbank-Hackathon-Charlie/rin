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
  {
    id: 3,
    sql: `
      -- Handoff deploys run old and new workers side by side; each worker heartbeats here.
      create table workers (
        id text primary key,
        version text not null,
        started_at timestamptz not null default now(),
        heartbeat_at timestamptz not null default now(),
        draining boolean not null default false
      );
      alter table jobs add column worker_id text;
      -- How many times the job was queued again after a redeploy or crash cut it off.
      alter table jobs add column resumed int not null default 0;
    `,
  },
  {
    id: 4,
    sql: `
      -- The SDK reports a resumed session's cost from its start; keep the last total to report each run's own cost.
      alter table threads add column session_cost_usd numeric(10, 4);
    `,
  },
  {
    id: 5,
    sql: `
      -- Read-only login for psql in Claude's Bash. The worker sets its password at start (src/db/reader.ts).
      -- Roles are cluster-wide, so another database on the same server may have made it already.
      do $$
      begin
        if not exists (select from pg_roles where rolname = 'rin_reader') then
          create role rin_reader login nosuperuser nocreatedb nocreaterole noreplication connection limit 4;
        end if;
      end $$;
      alter role rin_reader set default_transaction_read_only = on;
      alter role rin_reader set statement_timeout = '15s';
      grant usage on schema public to rin_reader;
      grant select on all tables in schema public to rin_reader;
      -- Tables that later migrations add (created by the main role) are readable too.
      alter default privileges in schema public grant select on tables to rin_reader;
      -- No temp tables either: the reader writes nothing.
      do $$ begin execute format('revoke temporary on database %I from public', current_database()); end $$;
    `,
  },
];
