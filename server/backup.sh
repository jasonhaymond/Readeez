#!/usr/bin/env bash
# backup.sh: a server backup you can actually restore from. It saves the database AND the
# settings files git doesn't hold (without server/.env a restored database can't be used),
# encrypts them into one file named after the version that was running, keeps it here, and
# copies it to Nextcloud if that's configured.
#
#   server/backup.sh       # run by hand, nightly from cron, and by update.sh before updating
#
# Output file: server/backups/readeez-v<version>-<timestamp>.tar.gz.gpg
# Prints that path on stdout; everything else goes to stderr.
# Exit codes: 0 fine. 1 no backup was made. 3 a local backup was made but the Nextcloud copy
# failed, so it's safe to continue, but this machine holds the only copy.
#
# Every run is recorded in the database's backup_runs table, shown in the app under
# Settings > Server. Restore with server/restore.sh (see docs/admin-guide.md).
set -euo pipefail

# Not as root, so nothing here ends up owned by root.
if [ "$(id -u)" = "0" ]; then
  echo "Don't run backup.sh as root. Run it as the account that owns this checkout." >&2
  exit 1
fi

# This script never asks anything, so it gives up keyboard input. Otherwise the Docker commands below
# would read from it, swallowing whatever someone types next in the terminal admin panel.
exec < /dev/null

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SERVER_DIR"
if [ ! -f .env ]; then
  echo ".env not found in $SERVER_DIR. Run server/setup.sh first." >&2
  exit 1
fi

# Everything made from here on is readable only by this account: it's full of secrets.
umask 077

# Reads one value from .env without running the file as a script, so a value containing
# shell characters can't execute anything. The last matching line wins.
env_get() {
  local line
  line="$(grep -E "^$1=" .env | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  printf '%s' "${line#\"}"
}

PASSPHRASE="$(env_get BACKUP_PASSPHRASE)"
if [ -z "$PASSPHRASE" ] || [ "$PASSPHRASE" = "change-me" ]; then
  echo "BACKUP_PASSPHRASE isn't set in .env. No backup was made." >&2
  exit 1
fi

# Runs SQL in the database. The -T stops Docker expecting a keyboard, so this works from cron.
psql_db() { docker compose exec -T postgres psql -U readeez -d readeez "$@"; }

# Named after the version actually running, read from the database (see appMeta.js) rather
# than from a file on disk, which can differ partway through an update.
VERSION="$(psql_db -tAc "select app_version from app_meta where id = 1" 2>/dev/null | tr -d '[:space:]' || true)"
VERSION="${VERSION:-unknown}"

# Records this run in backup_runs. Values go in as psql variables, whose :'name' form quotes
# them safely, so an error message containing a quote can't break out into SQL. Failing to
# record (the database may be what's down) must not hide the real result.
record_run() {
  psql_db -q -v ok="$1" -v ver="$VERSION" -v file="$2" -v up="$3" -v msg="$4" >/dev/null 2>&1 <<'SQL' || true
insert into backup_runs (ok, app_version, file_name, uploaded, message)
values (:'ok'::boolean, :'ver', nullif(:'file', ''), :'up'::boolean, nullif(:'msg', ''));
SQL
}

# Called if anything below fails unexpectedly: removes the work folder, records the failure.
WORK=""
cleanup() { [ -z "$WORK" ] || rm -rf "$WORK"; }
trap cleanup EXIT
fail() {
  echo "Backup failed: $1" >&2
  record_run false "" false "$1"
  exit 1
}

mkdir -p backups
chmod 700 backups
WORK="$(mktemp -d "$SERVER_DIR/backups/.work.XXXXXX")"
BASE="readeez-v${VERSION}-$(date +%Y%m%d-%H%M%S)"
OUT="backups/$BASE.tar.gz.gpg"

echo "Saving the database (running v$VERSION)..." >&2
# --clean --if-exists: the dump drops what it recreates, so it can be restored over a
# database that already has data. A plain dump fails partway through there.
docker compose exec -T postgres pg_dump --clean --if-exists -U readeez readeez > "$WORK/database.sql" \
  || fail "pg_dump failed"
# A dump this small means something's wrong, so it fails here instead of at restore time.
[ "$(wc -c < "$WORK/database.sql")" -gt 1000 ] || fail "the database dump is suspiciously small"
grep -q 'PostgreSQL database dump complete' "$WORK/database.sql" || fail "the database dump is incomplete"

mkdir "$WORK/config"
cp .env "$WORK/config/.env"
[ ! -f docker-compose.override.yml ] || cp docker-compose.override.yml "$WORK/config/"
printf '%s\n' "$VERSION" > "$WORK/VERSION"

echo "Encrypting to $OUT..." >&2
# The passphrase goes through a private file descriptor (3), not the command line, where any
# account on this machine could read it from the process list.
tar -czf - -C "$WORK" database.sql config VERSION \
  | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
      --symmetric --cipher-algo AES256 --output "$OUT" 3<<<"$PASSPHRASE" \
  || fail "encryption failed"

# Proves the file really decrypts and unpacks. An unverified backup is only a hope.
gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$OUT" 3<<<"$PASSPHRASE" \
  | tar -tzf - > /dev/null || fail "the new backup file failed verification"

# Deletes the oldest local backups past the limit. The pattern matches only this script's
# files, so nothing else in the folder can be removed.
KEEP_LOCAL="$(env_get BACKUP_KEEP_LOCAL)"
find backups -maxdepth 1 -type f -name 'readeez-v*.tar.gz.gpg' -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n +"$(( ${KEEP_LOCAL:-14} + 1 ))" | cut -d' ' -f2- | while IFS= read -r old; do
      rm -f -- "$old"
    done

# --- The off-machine copy ----------------------------------------------------------------
NC_URL="$(env_get BACKUP_NEXTCLOUD_URL)"
NC_URL="${NC_URL%/}"
NC_USER="$(env_get BACKUP_NEXTCLOUD_USER)"
NC_PASS="$(env_get BACKUP_NEXTCLOUD_APP_PASSWORD)"
NC_FOLDER="$(env_get BACKUP_NEXTCLOUD_FOLDER)"
NC_FOLDER="${NC_FOLDER:-Readeez-backups}"

if [ -z "$NC_URL" ]; then
  record_run true "$BASE.tar.gz.gpg" false "No Nextcloud is configured, so this machine holds the only copy."
  echo "$OUT"
  exit 0
fi

# Calls Nextcloud. The credentials reach curl through a private config stream rather than the
# command line, for the same reason as the passphrase above. --fail turns an HTTP error into a
# failure, and the time limit stops a dead connection hanging the nightly job.
nc_curl() {
  curl --silent --show-error --max-time 900 --config <(printf 'user = "%s:%s"\n' "$NC_USER" "$NC_PASS") "$@"
}
DAV="$NC_URL/remote.php/dav/files/$NC_USER/$NC_FOLDER"

echo "Copying to Nextcloud..." >&2
# Creating a folder that already exists answers 405, which is fine, so the code is checked
# by hand here rather than with --fail.
CODE="$(nc_curl --output /dev/null --write-out '%{http_code}' -X MKCOL "$DAV" || echo 000)"
if [ "$CODE" != "201" ] && [ "$CODE" != "405" ]; then
  MSG="Nextcloud copy failed: creating the folder answered $CODE. This machine holds the only copy."
  echo "$MSG" >&2
  record_run true "$BASE.tar.gz.gpg" false "$MSG"
  echo "$OUT"
  exit 3
fi
if ! nc_curl --fail --output /dev/null --upload-file "$OUT" "$DAV/$BASE.tar.gz.gpg"; then
  MSG="Nextcloud copy failed during upload. This machine holds the only copy."
  echo "$MSG" >&2
  record_run true "$BASE.tar.gz.gpg" false "$MSG"
  echo "$OUT"
  exit 3
fi

# Deletes the oldest copies in Nextcloud past the limit. Timestamped names sort by age, and
# the exact pattern means only this script's files can ever be removed. A failure here isn't
# worth failing a good backup over.
KEEP_REMOTE="$(env_get BACKUP_KEEP_REMOTE)"
LISTING="$(nc_curl --fail -X PROPFIND -H 'Depth: 1' "$DAV" || true)"
# Pulls names like readeez-v1.0.0-20261104-030000.tar.gz.gpg out of the XML reply, sorting
# on the timestamp rather than the version, which comes first in the name.
printf '%s' "$LISTING" | grep -oE 'readeez-v[0-9A-Za-z.]+-[0-9]{8}-[0-9]{6}\.tar\.gz\.gpg' | sort -u \
  | sed -E 's/^(.*-)([0-9]{8}-[0-9]{6})(\.tar\.gz\.gpg)$/\2 \1\2\3/' | sort -r \
  | tail -n +"$(( ${KEEP_REMOTE:-30} + 1 ))" | cut -d' ' -f2 | while IFS= read -r old; do
      nc_curl --output /dev/null -X DELETE "$DAV/$old" || true
    done

record_run true "$BASE.tar.gz.gpg" true ""
echo "Backup complete, with a copy in Nextcloud." >&2
echo "$OUT"
