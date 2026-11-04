#!/usr/bin/env bash
# host-agent.sh: the small helper that lets the app's Back up now and Update buttons work. The API runs
# in a container and can't touch the host, so it writes a request to the admin_jobs table, and this
# script, run every minute from this account's crontab, picks it up and runs the normal script.
#
# It opens no network port and accepts only what admin_jobs allows: "backup" or "update" to a version
# whose format it checks again here. update.sh still refuses any version without a recorded security
# approval, so even a compromised API can't get unapproved code deployed through this.
#
#   server/host-agent.sh       # one pass; cron runs this. server/install-cron.sh sets that up.
set -uo pipefail

if [ "$(id -u)" = "0" ]; then
  echo "Don't run host-agent.sh as root." >&2
  exit 1
fi
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SERVER_DIR" || exit 1
[ -f .env ] || exit 0
umask 077
mkdir -p backups

# Only one copy at a time. An update takes minutes, and cron starts this again every minute.
# flock holds the lock through file descriptor 9, and -n means "give up if it's taken".
exec 9> backups/.agent.lock
flock -n 9 || exit 0

# Runs SQL in the database. -T stops Docker expecting a keyboard, so this works from cron.
psql_db() { docker compose exec -T postgres psql -qtA -U readeez -d readeez "$@"; }

# Records that this helper is alive, for the app's Server panel. If the database is down, there's
# nothing this pass can do.
psql_db -c 'update app_meta set agent_seen_at = now() where id = 1' > /dev/null 2>&1 || exit 0

# A job left "running" this long means the helper or the machine died partway. Without this, the
# one-job-at-a-time rule would block every later job.
psql_db -c "update admin_jobs set status = 'failed', finished_at = now(), output = 'The job stopped unexpectedly. Check the server.' where status = 'running' and started_at < now() - interval '45 minutes'" > /dev/null 2>&1

# Claims the oldest waiting job in one step. Fields come back separated by a tab.
JOB="$(psql_db -F $'\t' -c "update admin_jobs set status = 'running', started_at = now() where id = (select id from admin_jobs where status = 'queued' order by id limit 1) returning id, kind, coalesce(arg, '')" 2> /dev/null)"
[ -n "$JOB" ] || exit 0
IFS=$'\t' read -r JOB_ID KIND ARG <<< "$JOB"

LOG="$(mktemp "$SERVER_DIR/backups/.job.XXXXXX")"
RESULT=failed
case "$KIND" in
  backup)
    # 9>&- keeps the lock from being inherited by anything the script starts. Any other exit code,
    # including 3 (saved locally, but the Nextcloud copy failed), is recorded as a failure, so the
    # person who asked sees it, and the output says what happened.
    if bash ./backup.sh > "$LOG" 2>&1 9>&-; then RESULT=succeeded; fi
    ;;
  update)
    # The table's value reaches a command line here, so only an exact version shape is accepted, e.g.
    # v1.2.3. Nothing else, such as a value starting with a dash, gets through to the script.
    if [[ "$ARG" =~ ^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]]; then
      if bash ./update.sh "$ARG" > "$LOG" 2>&1 9>&-; then RESULT=succeeded; fi
    else
      echo "Refused: that isn't a version number." > "$LOG"
    fi
    ;;
  *)
    echo "Refused: unknown kind of job." > "$LOG"
    ;;
esac

# Saves the end of the output. Values go in as psql variables, whose :'name' form quotes them safely,
# so output containing a quote can't break out into SQL.
OUTPUT="$(tail -c 8000 "$LOG")"
docker compose exec -T postgres psql -q -U readeez -d readeez -v id="$JOB_ID" -v status="$RESULT" -v output="$OUTPUT" > /dev/null 2>&1 <<'SQL'
update admin_jobs set status = :'status', output = :'output', finished_at = now() where id = :'id'::bigint;
SQL
rm -f "$LOG"
