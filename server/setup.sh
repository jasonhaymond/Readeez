#!/usr/bin/env bash
# setup.sh: first-time server setup. It checks prerequisites, asks a few questions, writes
# server/.env, starts everything, and prints your first admin invite code. Safe to re-run: it
# asks before replacing an existing .env. docs/admin-guide.md has the same steps by hand.
#
# It only touches files this account owns. It never needs root. Anything that does (the reverse
# proxy, the firewall) is printed for you to run yourself, deliberately.
set -euo pipefail

if [ "$(id -u)" = "0" ]; then
  echo "Don't run setup.sh with sudo. Run it as the account that will own this checkout." >&2
  exit 1
fi
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SERVER_DIR"

# Asks a question with a default. In: prompt, default. Out: the answer on stdout.
ask() {
  local answer
  read -r -p "$1 [$2]: " answer
  printf '%s' "${answer:-$2}"
}

# --- Prerequisites -----------------------------------------------------------------------
MISSING=""
for tool in docker git gpg curl openssl; do
  command -v "$tool" > /dev/null 2>&1 || MISSING="$MISSING $tool"
done
if [ -n "$MISSING" ]; then
  echo "Missing:$MISSING. Install with your package manager, for example:" >&2
  echo "  sudo apt install git gnupg curl openssl" >&2
  echo "  Docker: https://docs.docker.com/engine/install/" >&2
  exit 1
fi
if ! docker compose version > /dev/null 2>&1; then
  echo "The Docker Compose plugin is missing: https://docs.docker.com/compose/install/linux/" >&2
  exit 1
fi
if ! docker info > /dev/null 2>&1; then
  echo "This account can't use Docker. Add it, then log out and back in:" >&2
  echo "  sudo usermod -aG docker $USER" >&2
  exit 1
fi

# --- Settings ----------------------------------------------------------------------------
WRITE_ENV=1
if [ -f .env ]; then
  ANSWER="$(ask "server/.env already exists. Replace it? Replacing loses its secrets" "no")"
  [ "$ANSWER" = "yes" ] || WRITE_ENV=0
fi

if [ "$WRITE_ENV" = "1" ]; then
  # Finds what's listening, to choose a port that's free. The default is only a starting point.
  port_in_use() {
    if command -v ss > /dev/null 2>&1; then
      ss -ltn | awk '{print $4}' | grep -qE "[:.]$1\$"
    else
      (exec 3<>"/dev/tcp/127.0.0.1/$1") 2> /dev/null
    fi
  }
  PORT=3020
  while port_in_use "$PORT"; do PORT=$((PORT + 1)); done
  PORT="$(ask "Port for the API (first free one found)" "$PORT")"
  if port_in_use "$PORT"; then
    echo "Port $PORT is already in use. Run this again and choose another." >&2
    exit 1
  fi

  echo
  echo "Is your reverse proxy (Caddy) on this machine, or a different one?"
  TOPOLOGY="$(ask "Enter 'here' or 'other'" "here")"
  BIND=127.0.0.1
  if [ "$TOPOLOGY" = "other" ]; then
    BIND="$(ask "This machine's private address, which the proxy will connect to" "")"
    [ -n "$BIND" ] || { echo "An address is needed for a proxy on another machine." >&2; exit 1; }
  fi
  PUBLIC_URL="$(ask "Public address of this server, e.g. https://readeez.example.com" "")"

  echo
  echo "Nightly backups can be copied to a Nextcloud. Without this, they stay only on this machine,"
  echo "and won't survive losing it. Create an app password in Nextcloud for this."
  NC_URL="$(ask "Nextcloud address (leave empty to skip)" "")"
  NC_USER=""
  NC_PASS=""
  if [ -n "$NC_URL" ]; then
    NC_USER="$(ask "Nextcloud user name" "")"
    # -s hides the password as it's typed.
    read -r -s -p "Nextcloud app password: " NC_PASS
    echo
  fi

  PG_PASS="$(openssl rand -hex 24)"
  SECRETS="$(openssl rand -hex 32)"
  BACKUP_PASS="$(openssl rand -hex 32)"

  # Readable only by this account, since it's full of secrets.
  umask 077
  cat > .env <<EOF
POSTGRES_PASSWORD=$PG_PASS
SECRETS_KEY=$SECRETS
BACKUP_PASSPHRASE=$BACKUP_PASS
READEEZ_PORT=$PORT
READEEZ_BIND=$BIND
TRUST_PROXY=1
CORS_ALLOWED_ORIGINS=
PUBLIC_URL=$PUBLIC_URL
NEXTCLOUD_ALLOWED_PRIVATE_HOSTS=
BACKUP_NEXTCLOUD_URL=$NC_URL
BACKUP_NEXTCLOUD_USER=$NC_USER
BACKUP_NEXTCLOUD_APP_PASSWORD=$NC_PASS
BACKUP_NEXTCLOUD_FOLDER=Readeez-backups
BACKUP_KEEP_LOCAL=14
BACKUP_KEEP_REMOTE=30
UPDATE_CHECK_REPO=jasonhaymond/Readeez
EOF
  chmod 600 .env

  # The one secret that can't live only here: the backup holds this file, so it can't be used to
  # open itself. This is the only time it's displayed by this script.
  echo
  echo "=================================================================="
  echo "  BACKUP PASSPHRASE. Save this in your password manager NOW."
  echo
  echo "  $BACKUP_PASS"
  echo
  echo "  Without it, no backup can ever be opened. It isn't shown again."
  echo "=================================================================="
  while true; do
    read -r -p "Type SAVED once it's in your password manager: " CONFIRM
    [ "$CONFIRM" = "SAVED" ] && break
  done
fi

# --- Start -------------------------------------------------------------------------------
echo "Building and starting..."
docker compose up -d --build

line="$(grep -E '^READEEZ_PORT=' .env | tail -n 1 || true)"
PORT="${line#*=}"
line="$(grep -E '^READEEZ_BIND=' .env | tail -n 1 || true)"
BIND="${line#*=}"
HEALTH="http://${BIND:-127.0.0.1}:${PORT:-3020}/api/health"
for _ in $(seq 1 60); do
  curl -sf "$HEALTH" > /dev/null && HEALTHY=1 && break
  sleep 2
done
if [ "${HEALTHY:-0}" != "1" ]; then
  echo "The API didn't start. Check: docker compose logs api" >&2
  exit 1
fi
echo "The API is running at $HEALTH."

# --- Scheduled jobs, in this account's own crontab --------------------------------------
ANSWER="$(ask "Schedule the nightly backup at 3:00, and the helper for the app's admin buttons?" "yes")"
if [ "$ANSWER" = "yes" ]; then
  bash ./install-cron.sh
fi

# --- First admin ---------------------------------------------------------------------------
HAS_ADMIN="$(docker compose exec -T postgres psql -U readeez -d readeez -tAc "select count(*) from users where role = 'admin'" | tr -d '[:space:]')"
if [ "$HAS_ADMIN" = "0" ]; then
  docker compose exec -T api node scripts/create-admin-invite.js
fi

# --- What needs root is printed, never run -------------------------------------------------
cat <<EOF

Remaining steps need root, so run them yourself:

1. Reverse proxy. Add this to your Caddyfile, then: sudo systemctl reload caddy

   readeez.example.com {
       reverse_proxy ${BIND:-127.0.0.1}:${PORT:-3020}
   }

2. Firewall. Allow only SSH, 80 and 443 from the internet. Never open port ${PORT:-3020}.

3. Run a test backup now: server/backup.sh

To manage the server from now on, run the terminal admin panel: server/admin.sh
See docs/admin-guide.md for the rest.
EOF
