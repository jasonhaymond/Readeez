#!/usr/bin/env bash
# update.sh: one command to update a running server: back up, get the code, rebuild, restart,
# and verify. Also how you roll back: naming an older version deploys exactly that version.
#
#   server/update.sh           # deploy the newest released version
#   server/update.sh v1.2.0    # deploy exactly that version (newer or older)
#
# Safety checks: it refuses to run over uncommitted changes, refuses any version without a
# recorded security approval in its tag, and always backs up first.
#
# WHAT A ROLLBACK DOES AND DOESN'T DO: the CODE goes back completely and reproducibly. The
# DATABASE is not touched. If nothing about the schema changed between the versions, that's
# all you need. If a column or table was renamed, removed or tightened, the old code can break
# against the current schema, and the only real fix is restoring a backup from that version
# (server/restore.sh), which DISCARDS everything added since. This script never does that for
# you. CHANGELOG.md notes each version's schema changes.
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  echo "Don't run update.sh with sudo. Run it as the account that owns this checkout." >&2
  exit 1
fi

# This script never asks anything, so it gives up keyboard input. Otherwise the Docker commands below
# would read from it, swallowing whatever someone types next in the terminal admin panel.
exec < /dev/null

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SERVER_DIR" rev-parse --show-toplevel)"
cd "$SERVER_DIR"

# A hand-edited tracked file on a server is what makes the next update conflict, or silently
# undoes the edit. Server-specific values belong in .env.
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "Refusing to update: there are uncommitted changes in this checkout:" >&2
  git -C "$REPO_ROOT" status --short >&2
  exit 1
fi
[ -f .env ] || { echo ".env not found. Run server/setup.sh first." >&2; exit 1; }

# Reads one value from .env without running it as a script.
env_get() {
  local line
  line="$(grep -E "^$1=" .env | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  printf '%s' "${line#\"}"
}

# Set when this script restarted itself after checking out a newer copy of itself (see below).
RESUMED_BACKUP="${READEEZ_UPDATE_RESUMED_BACKUP:-}"
SELF_SUM="$(cksum < "$SERVER_DIR/update.sh")"

git -C "$REPO_ROOT" fetch --tags --quiet origin

# The newest version tag, unless one was named. Tags, not the main branch, because a tag is
# what carries the security approval.
TARGET="${1:-$(git -C "$REPO_ROOT" tag -l 'v*' --sort=-v:refname | head -n 1)}"
if [ -z "$TARGET" ] || ! git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$TARGET" > /dev/null; then
  echo "No such version: ${TARGET:-none found}. Available versions:" >&2
  git -C "$REPO_ROOT" tag -l 'v*' --sort=-v:refname >&2
  exit 1
fi

# Enforces the security gate with tooling, rather than relying on anyone's memory.
bash "$REPO_ROOT/scripts/verify-release-tag.sh" "$TARGET"

CURRENT="$(docker compose exec -T postgres psql -U readeez -d readeez -tAc 'select app_version from app_meta where id = 1' 2>/dev/null | tr -d '[:space:]' || true)"
echo "Running now: v${CURRENT:-unknown}. Deploying: $TARGET."
if [ -n "${1:-}" ]; then
  echo "This moves the CODE to exactly $TARGET and leaves the database alone. Check CHANGELOG.md"
  echo "for schema changes between the two versions. See the note at the top of this script."
fi

if [ -n "$RESUMED_BACKUP" ]; then
  BACKUP_FILE="$RESUMED_BACKUP"
else
  # Code 3 means the local backup is fine and only its Nextcloud copy failed. Worth a warning,
  # not worth blocking an update.
  BACKUP_CODE=0
  BACKUP_FILE="$(bash ./backup.sh)" || BACKUP_CODE=$?
  if [ "$BACKUP_CODE" = "3" ]; then
    echo "Warning: the backup's Nextcloud copy failed. Continuing with the local copy." >&2
  elif [ "$BACKUP_CODE" != "0" ]; then
    echo "The pre-update backup failed, so nothing was changed." >&2
    exit 1
  fi

  git -C "$REPO_ROOT" checkout --quiet "$TARGET"

  # Bash keeps running the copy of this script it started with. If that version has a different
  # one, hand over to it, so its steps apply to this update and not the next.
  if [ "$(cksum < "$SERVER_DIR/update.sh")" != "$SELF_SUM" ]; then
    READEEZ_UPDATE_RESUMED_BACKUP="$BACKUP_FILE" exec bash "$SERVER_DIR/update.sh" "$TARGET"
  fi
fi
docker compose up -d --build

# Migrations run as the API starts. "Healthy" means it finished them and can reach its database.
PORT="$(env_get READEEZ_PORT)"
BIND="$(env_get READEEZ_BIND)"
HEALTH="http://${BIND:-127.0.0.1}:${PORT:-3020}/api/health"
echo "Waiting for the API..."
for _ in $(seq 1 60); do
  if curl -sf "$HEALTH" > /dev/null; then
    HEALTHY=1
    break
  fi
  sleep 2
done
if [ "${HEALTHY:-0}" != "1" ]; then
  echo "The API didn't answer at $HEALTH. Check: docker compose logs api" >&2
  echo "The pre-update backup is server/$BACKUP_FILE." >&2
  exit 1
fi

# Confirms it's really the new version serving, as recorded by the API when it started.
EXPECTED="${TARGET#v}"
RUNNING="$(docker compose exec -T postgres psql -U readeez -d readeez -tAc 'select app_version from app_meta where id = 1' | tr -d '[:space:]')"
if [ "$RUNNING" != "$EXPECTED" ]; then
  echo "The API is up, but reports v$RUNNING rather than v$EXPECTED. Check: docker compose logs api" >&2
  exit 1
fi
echo "Now running v$RUNNING. Pre-update backup: server/$BACKUP_FILE"

# Checks the public address from the outside: TLS, headers, protected routes, rate limits.
PUBLIC_URL_VALUE="$(env_get PUBLIC_URL)"
if [ -n "$PUBLIC_URL_VALUE" ]; then
  bash "$REPO_ROOT/scripts/security-check.sh" --live "$PUBLIC_URL_VALUE"
else
  echo "PUBLIC_URL isn't set in .env, so the post-update security check was skipped." >&2
fi
