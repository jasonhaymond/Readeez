#!/usr/bin/env bash
# restore.sh: brings the database back from an encrypted backup made by backup.sh. Also works
# on a brand-new machine: if server/.env is missing, it's restored from the backup first.
#
#   server/restore.sh backups/readeez-v1.0.0-20261104-030000.tar.gz.gpg
#
# THIS REPLACES THE WHOLE DATABASE, and everything added since that backup is discarded. It
# therefore shows which version and file it would restore, requires typing RESTORE, and first
# takes a fresh backup of the current data, so even a mistaken restore can be undone.
#
# Phones recover by themselves: this script marks the database as restored, so on their next sync
# they download its current state and send back any books it no longer has (see routes/sync.js).
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  echo "Don't run restore.sh as root. Run it as the account that owns this checkout." >&2
  exit 1
fi
if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: server/restore.sh <backup file>" >&2
  echo "Available backups:" >&2
  ls -1t "$(dirname "${BASH_SOURCE[0]}")/backups/"readeez-v*.tar.gz.gpg 2>/dev/null >&2 || echo "  (none on this machine)" >&2
  exit 1
fi
BACKUP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SERVER_DIR"
umask 077

# Reads one value from .env without running it as a script.
env_get() {
  local line
  line="$(grep -E "^$1=" .env 2>/dev/null | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  printf '%s' "${line#\"}"
}

# On a replacement machine there's no .env yet, so the passphrase comes from the person's
# password manager. It's read without showing it on screen.
PASSPHRASE="$(env_get BACKUP_PASSPHRASE)"
if [ -z "$PASSPHRASE" ]; then
  read -r -s -p "Backup passphrase (from your password manager): " PASSPHRASE
  echo
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# The passphrase travels on a private file descriptor (3), not the visible command line.
if ! gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$BACKUP" 3<<<"$PASSPHRASE" \
  | tar -xzf - -C "$WORK"; then
  echo "Couldn't open that backup: the passphrase is wrong or the file is damaged." >&2
  exit 1
fi
[ -f "$WORK/database.sql" ] || { echo "That file isn't a Readeez backup." >&2; exit 1; }

echo
echo "  Backup file:     $(basename "$BACKUP")"
echo "  App version:     $(cat "$WORK/VERSION")"
echo "  This will REPLACE the whole database. Anything added since that backup is DISCARDED."
echo
read -r -p "Type RESTORE to continue: " ANSWER
[ "$ANSWER" = "RESTORE" ] || { echo "Cancelled. Nothing was changed."; exit 1; }

# Nothing further is asked, so this gives up keyboard input. Otherwise the Docker commands below would
# read from it, swallowing whatever someone types next in the terminal admin panel.
exec < /dev/null

# Settings: restored only if there are none. Existing settings are never overwritten, because
# they may be newer. The backup's copy is left beside them for comparison.
if [ ! -f .env ]; then
  echo "No server/.env here, so restoring it from the backup."
  cp "$WORK/config/.env" .env
  chmod 600 .env
  [ ! -f "$WORK/config/docker-compose.override.yml" ] || cp "$WORK/config/docker-compose.override.yml" .
  FRESH_MACHINE=1
else
  FRESH_MACHINE=0
  SAVED="backups/config-from-$(basename "$BACKUP" .tar.gz.gpg)"
  mkdir -p backups "$SAVED"
  cp "$WORK/config/.env" "$SAVED/.env"
  echo "Kept your current server/.env. The backup's copy is at server/$SAVED/.env, if you need it."
fi

docker compose up -d --wait postgres

# Takes a safety backup of what's about to be replaced. A brand-new machine has nothing to
# save, and a failure here stops the restore rather than risk losing the only copy.
if [ "$FRESH_MACHINE" = "0" ]; then
  echo "Taking a safety backup of the current data first..."
  SAFETY_CODE=0
  SAFETY="$(bash ./backup.sh)" || SAFETY_CODE=$?
  # Code 3 means the local file is fine and only the Nextcloud copy failed.
  if [ "$SAFETY_CODE" != "0" ] && [ "$SAFETY_CODE" != "3" ]; then
    echo "The safety backup failed, so nothing was restored." >&2
    exit 1
  fi
  echo "Safety backup: server/$SAFETY"
fi

# Stops the API, so nobody writes to the database while it's replaced.
docker compose stop api
echo "Restoring the database..."
# ON_ERROR_STOP halts at the first error instead of carrying on with a half-restored database.
# --single-transaction makes the whole restore succeed or leave the database as it was.
docker compose exec -T postgres psql -q -v ON_ERROR_STOP=1 --single-transaction -U readeez -d readeez \
  < "$WORK/database.sql" > /dev/null

docker compose up -d --build api

PORT="$(env_get READEEZ_PORT)"
BIND="$(env_get READEEZ_BIND)"
HEALTH="http://${BIND:-127.0.0.1}:${PORT:-3020}/api/health"
for _ in $(seq 1 30); do
  if curl -sf "$HEALTH" > /dev/null; then
    # Tells phones the database was restored, so they start their sync over rather than trust
    # positions from before. It waits for the API, whose startup adds this column to older backups.
    docker compose exec -T postgres psql -q -U readeez -d readeez -c 'update app_meta set sync_epoch = gen_random_uuid() where id = 1' > /dev/null
    # The database's own record of the version is the proof of what came back. The API has
    # already rewritten it to the code now running, so it's shown next to the backup's.
    RUNNING="$(docker compose exec -T postgres psql -U readeez -d readeez -tAc 'select app_version from app_meta where id = 1' | tr -d '[:space:]')"
    BOOKS="$(docker compose exec -T postgres psql -U readeez -d readeez -tAc 'select count(*) from books where not deleted' | tr -d '[:space:]')"
    echo
    echo "Restore complete. Data from v$(cat "$WORK/VERSION"), now running v$RUNNING, with $BOOKS books."
    exit 0
  fi
  sleep 2
done
echo "The database was restored, but the API isn't answering at $HEALTH. Check: docker compose logs api" >&2
exit 1
