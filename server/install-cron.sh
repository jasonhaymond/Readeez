#!/usr/bin/env bash
# install-cron.sh: adds Readeez's two scheduled jobs to this account's crontab: the nightly backup at
# 3:00, and the helper that runs every minute so the app's Back up now and Update buttons work. Safe to
# run again: it replaces its own lines and leaves the rest of the crontab alone. Needs no root, because
# the crontab belongs to this account.
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  echo "Don't run install-cron.sh as root. Run it as the account that owns this checkout." >&2
  exit 1
fi
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$SERVER_DIR/backups"

# Cron's default PATH is minimal, and on some systems doesn't include Docker's location.
CRON_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
BACKUP_JOB="0 3 * * * PATH=$CRON_PATH; cd \"$SERVER_DIR\" && bash ./backup.sh >> backups/backup.log 2>&1 # readeez-backup"
AGENT_JOB="* * * * * PATH=$CRON_PATH; cd \"$SERVER_DIR\" && bash ./host-agent.sh > /dev/null 2>&1 # readeez-agent"

# Keeps every other line, drops any earlier copy of these two, and adds them back. `crontab -l` fails
# when there's no crontab yet, which is fine.
{ crontab -l 2> /dev/null | grep -vE '# readeez-(backup|agent)$' || true; printf '%s\n%s\n' "$BACKUP_JOB" "$AGENT_JOB"; } | crontab -
echo "Scheduled: a nightly backup at 3:00, and the helper every minute."
