-- 001_initial.sql
-- The whole Readeez database as first shipped. Applied once by migrate.js, which
-- records it in schema_migrations. Migrations are forward-only: a later change
-- goes in a new numbered file, never by editing this one.

-- Family members who can sign in. There is no public sign-up: a row appears here
-- only when someone redeems an admin-issued invite code (see access_codes).
create table users (
  id            uuid primary key default gen_random_uuid(),
  -- Always stored lower-case (the check enforces it) so "Sam@x.com" and
  -- "sam@x.com" can't become two accounts.
  email         text not null unique check (email = lower(email)),
  display_name  text not null,
  -- A bcrypt hash, never the password itself.
  password_hash text not null,
  role          text not null check (role in ('admin', 'member')),
  -- Set when an admin disables the account; such an account can't sign in.
  disabled_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- One row per signed-in device. Only a SHA-256 hash of the token is stored, so
-- someone reading a database backup can't use it to act as a family member.
create table sessions (
  token_hash   text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index sessions_user_idx on sessions(user_id);

-- One-time codes an admin gives someone: 'invite' creates a new account,
-- 'reset' sets a new password on an existing one. Hashed for the same reason as
-- session tokens; the plain code is shown once, when it's created.
create table access_codes (
  code_hash  text primary key,
  kind       text not null check (kind in ('invite', 'reset')),
  -- The role an invite grants. Empty for a reset, which keeps the existing role.
  role       text check (role in ('admin', 'member')),
  -- The account a reset applies to. Empty for an invite.
  user_id    uuid references users(id) on delete cascade,
  -- Empty for codes made on the server's command line, and once the creator's account is deleted.
  created_by uuid references users(id) on delete set null,
  expires_at timestamptz not null,
  -- Set the moment the code is redeemed, which is what makes it single-use.
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'invite' and role is not null and user_id is null)
      or (kind = 'reset' and role is null and user_id is not null))
);

-- Numbers each change to any book. A phone remembers the highest number it has
-- seen and asks only for newer ones (see routes/sync.js).
create sequence books_seq;

-- Each person's books. The primary key includes user_id, so two accounts sending
-- the same book id get two separate rows: one person can never overwrite or read
-- another's book by guessing its id.
create table books (
  user_id    uuid not null references users(id) on delete cascade,
  -- Made by the phone (a UUID), so a book can be created offline.
  id         uuid not null,
  title      text not null,
  -- Names are kept on the book rather than in separate tables: there is nothing
  -- to reconcile when two offline devices type the same new author.
  authors    text[] not null default '{}',
  categories text[] not null default '{}',
  status     text not null check (status in ('want', 'reading', 'finished')),
  rating     smallint check (rating between 1 and 5),
  read_date  date,
  notes      text not null default '',
  -- When the edit was made on the device; decides which edit wins a conflict.
  updated_at timestamptz not null,
  -- A deleted book stays as an emptied marker so other devices learn it's gone.
  deleted    boolean not null default false,
  seq        bigint not null default nextval('books_seq'),
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  -- A live book must have a title; only a deleted marker may be blank.
  check (deleted or length(title) > 0)
);
create index books_user_seq_idx on books(user_id, seq);

-- A person's own Nextcloud, where their exports go. The app password is encrypted
-- (secrets.js) and never sent back to any client.
create table nextcloud_links (
  user_id            uuid primary key references users(id) on delete cascade,
  base_url           text not null,
  username           text not null,
  app_password_enc   text not null,
  daily_export       boolean not null default true,
  last_export_at     timestamptz,
  last_error         text,
  updated_at         timestamptz not null default now()
);

-- The single row saying which app version last started against this database.
-- backup.sh names each backup after it (see appMeta.js).
create table app_meta (
  id          integer primary key check (id = 1),
  app_version text not null,
  updated_at  timestamptz not null default now()
);

-- A record of each server backup, written by backup.sh, shown to admins.
create table backup_runs (
  id          bigserial primary key,
  finished_at timestamptz not null default now(),
  ok          boolean not null,
  app_version text,
  file_name   text,
  uploaded    boolean not null default false,
  message     text
);
