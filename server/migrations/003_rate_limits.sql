-- 003_rate_limits.sql
-- Keeps rate-limit counts in the database rather than in memory, so restarting the server doesn't hand
-- someone guessing passwords a fresh set of attempts. Additive, so older code still runs against this schema.
-- Expired rows are removed hourly (see rateLimitStore.js). A key holds a network address or an account id,
-- never a password or token.
create table rate_limits (
  key      text primary key,
  hits     integer not null,
  reset_at timestamptz not null
);
create index rate_limits_reset_idx on rate_limits(reset_at);
