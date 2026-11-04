-- 002_admin_jobs.sql
-- Adds what the app's Back up now and Update buttons need, and a way for phones to reliably
-- notice a server restore. Purely additive, so older code still runs against this schema.

-- A random id that changes whenever the database is restored from a backup (restore.sh sets a
-- new one). A phone remembers it, so a change tells the phone to start its sync position over.
-- agent_seen_at is when the host helper (host-agent.sh) last checked in.
alter table app_meta
  add column sync_epoch uuid not null default gen_random_uuid(),
  add column agent_seen_at timestamptz;

-- Work an admin asked for in the app. The API runs in a container and can't touch the host, so
-- it only writes a request here. host-agent.sh, running on the host, picks it up. The kind is
-- limited to these two, so a compromised API still couldn't ask the host for anything else.
create table admin_jobs (
  id           bigserial primary key,
  kind         text not null check (kind in ('backup', 'update')),
  -- The version to deploy, for an update. host-agent.sh checks its format again before use.
  arg          text,
  status       text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  -- The end of the script's output, shown to admins.
  output       text,
  requested_by uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

-- Allows at most one unfinished job, enforced by the database itself. Two admins tapping at the
-- same moment can't start two updates. Every matching row indexes the same value, true.
create unique index admin_jobs_one_active on admin_jobs ((true)) where status in ('queued', 'running');
