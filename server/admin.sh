#!/usr/bin/env bash
# admin.sh: the terminal admin panel, for managing Readeez over SSH. A menu covers accounts, backups,
# restores, updates, rollbacks, logs and health, so there are no commands to remember.
#
#   server/admin.sh
#
# It runs as the account that owns this checkout. Having SSH access to that account is what authorizes
# it. Each action calls the same scripts documented in docs/admin-guide.md, so their safety checks
# all still apply. It needs nothing beyond what the server already requires.
#
# Secrets are never shown: settings display as "set" or "not set". Codes appear once, when they're
# created, and can't be shown again.
set -uo pipefail

if [ "$(id -u)" = "0" ]; then
  echo "Don't run admin.sh with sudo. Run it as the account that owns this checkout." >&2
  exit 1
fi
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SERVER_DIR/.." && pwd)"
cd "$SERVER_DIR" || exit 1
if [ ! -f .env ]; then
  echo "server/.env not found. Run server/setup.sh first." >&2
  exit 1
fi

# Colours only when a person is watching a terminal, so piped output stays clean. Status also always
# appears in words, never colour alone.
if [ -t 1 ]; then
  BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; OFF=$'\e[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; OFF=""
fi

# Reads one value from .env without running the file as a script.
env_get() {
  local line
  line="$(grep -E "^$1=" .env | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  printf '%s' "${line#\"}"
}

# Runs a command from scripts/admin-cli.js inside the API container. Its input is cut off, or Docker would
# read from the keyboard and swallow whatever's typed next at the menu.
cli() { docker compose exec -T api node scripts/admin-cli.js "$@" < /dev/null; }
api_up() {
  local bind port
  bind="$(env_get READEEZ_BIND)"
  port="$(env_get READEEZ_PORT)"
  curl -sf --max-time 5 "http://${bind:-127.0.0.1}:${port:-3020}/api/health" > /dev/null 2>&1
}

# Reads a line of input into ANSWER. If the input ends (the SSH session dropped), the panel exits
# rather than looping forever. It sets a variable instead of printing, because exit inside a $(...)
# would only leave that subshell.
ANSWER=""
ask() {
  if ! read -r -p "$1" ANSWER; then echo; exit 0; fi
}
pause() { ask "${DIM}Press Enter to go back.${OFF} "; }
heading() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }

# Asks someone to retype a word before something hard to undo.
# In: the word. Out: success only if it matches exactly.
confirm_word() {
  local reply
  ask "Type ${BOLD}$1${OFF} to continue, or anything else to cancel: "
  reply="$ANSWER"
  if [ "$reply" = "$1" ]; then return 0; fi
  echo "Cancelled. Nothing was changed."
  return 1
}

# ---- The status block at the top of the menu -----------------------------------------------------
show_status() {
  local name value version="" users="?" disabled="0" books="?" agent_age="-1" backup_at="" backup_ok="" backup_up="" backup_msg="" job=""
  printf '%sReadeez admin%s\n' "$BOLD" "$OFF"
  if ! api_up; then
    printf '  API      %sNOT RESPONDING%s. Try Health, or Logs.\n' "$RED" "$OFF"
    return
  fi
  while IFS=$'\t' read -r name value; do
    case "$name" in
      version) version="$value" ;;
      users) users="$value" ;;
      disabled) disabled="$value" ;;
      books) books="$value" ;;
      agent_age) agent_age="$value" ;;
      backup_at) backup_at="$value" ;;
      backup_ok) backup_ok="$value" ;;
      backup_uploaded) backup_up="$value" ;;
      backup_message) backup_msg="$value" ;;
      job) job="$value" ;;
    esac
  done < <(cli status 2> /dev/null)

  printf '  API      %shealthy%s, v%s\n' "$GREEN" "$OFF" "$version"
  printf '  Family   %s account%s' "$users" "$([ "$users" = 1 ] || echo s)"
  [ "$disabled" = 0 ] || printf ' (%s disabled)' "$disabled"
  printf ', %s book%s\n' "$books" "$([ "$books" = 1 ] || echo s)"
  if [ -z "$backup_at" ]; then
    printf '  Backup   %snone yet%s. Choose "Back up now".\n' "$YELLOW" "$OFF"
  elif [ "$backup_ok" != true ]; then
    printf '  Backup   %sFAILED%s %s: %s\n' "$RED" "$OFF" "$backup_at" "$backup_msg"
  elif [ "$backup_up" != true ]; then
    printf '  Backup   %son this machine only%s, %s: %s\n' "$YELLOW" "$OFF" "$backup_at" "$backup_msg"
  else
    printf '  Backup   %sOK%s, %s, copied to Nextcloud\n' "$GREEN" "$OFF" "$backup_at"
  fi
  # The helper checks in every minute, so a few minutes of silence means it isn't running.
  if [ "$agent_age" -lt 0 ] || [ "$agent_age" -gt 180 ]; then
    printf '  Helper   %snot running%s. The app'"'"'s Back up now and Update buttons need it. Choose "Schedule".\n' "$YELLOW" "$OFF"
  else
    printf '  Helper   %srunning%s\n' "$GREEN" "$OFF"
  fi
  [ -z "$job" ] || printf '  Last job %s\n' "$job"
}

# ---- Accounts ----------------------------------------------------------------------------------
USER_EMAILS=()

# Prints the numbered account list, and remembers the emails for choose_user.
list_users() {
  local email name role state books i=0
  USER_EMAILS=()
  printf '%s  #  %-32s %-20s %-8s %-9s %s%s\n' "$DIM" "Email" "Name" "Role" "State" "Books" "$OFF"
  while IFS=$'\t' read -r email name role state books; do
    i=$((i + 1))
    USER_EMAILS+=("$email")
    printf '%3d  %-32s %-20s %-8s %-9s %s\n' "$i" "$email" "$name" "$role" "$state" "$books"
  done < <(cli users)
  [ "$i" -gt 0 ] || echo "  No accounts yet."
}

# Asks which account, by number from the list. Out: sets CHOSEN_EMAIL, or fails if it's invalid.
choose_user() {
  local reply
  CHOSEN_EMAIL=""
  list_users
  [ "${#USER_EMAILS[@]}" -gt 0 ] || return 1
  ask "Which account? Number, or Enter to cancel: "
  reply="$ANSWER"
  if [[ "$reply" =~ ^[0-9]+$ ]] && [ "$reply" -ge 1 ] && [ "$reply" -le "${#USER_EMAILS[@]}" ]; then
    CHOSEN_EMAIL="${USER_EMAILS[$((reply - 1))]}"
    return 0
  fi
  return 1
}

# Shows a code once, in a form that stands out, and waits for the admin to confirm they've saved it.
# In: a title and the code.
show_code() {
  printf '\n  %s%s%s\n\n      %s%s%s\n\n' "$BOLD" "$1" "$OFF" "$BOLD" "$2" "$OFF"
  echo "  It works once, and can't be shown again."
  local reply=""
  while [ "$reply" != "SAVED" ]; do
    ask "  Type SAVED once you've noted it: "
    reply="$ANSWER"
  done
}

menu_accounts() {
  local choice role code
  while true; do
    heading "Accounts"
    echo "  1  List accounts"
    echo "  2  Invite someone"
    echo "  3  Password reset code"
    echo "  4  Disable an account"
    echo "  5  Enable an account"
    echo "  6  Make someone an admin or member"
    echo "  7  Delete an account"
    echo "  0  Back"
    ask "> "
    choice="$ANSWER"
    case "$choice" in
      1) heading "Accounts"; list_users ;;
      2)
        ask "Role, member or admin [member]: "
        role="$ANSWER"
        role="${role:-member}"
        if code="$(cli invite "$role")"; then
          show_code "Invite code ($role, lasts 7 days)" "$code"
          echo '  They choose "I have an invite code" when they open Readeez.'
        fi
        ;;
      3)
        if choose_user && code="$(cli reset "$CHOSEN_EMAIL")"; then
          show_code "Reset code for $CHOSEN_EMAIL (lasts 24 hours)" "$code"
          echo '  They choose "I have a password reset code" on the sign-in screen.'
        fi
        ;;
      4)
        if choose_user; then
          echo "$CHOSEN_EMAIL will be signed out everywhere and can't sign in. Their books are kept."
          confirm_word DISABLE && cli disable "$CHOSEN_EMAIL" && echo "Disabled."
        fi
        ;;
      5) if choose_user; then cli enable "$CHOSEN_EMAIL" && echo "Enabled."; fi ;;
      6)
        if choose_user; then
          ask "Make $CHOSEN_EMAIL a member or an admin? "
          role="$ANSWER"
          cli role "$CHOSEN_EMAIL" "$role" && echo "$CHOSEN_EMAIL is now: $role."
        fi
        ;;
      7)
        if choose_user; then
          printf '%sThis permanently deletes %s and all their books and notes.%s\n' "$RED" "$CHOSEN_EMAIL" "$OFF"
          echo "Only restoring a backup can bring them back, and that discards everyone's later changes."
          echo "Disable keeps their books, if that's all you need."
          local typed
          ask "Retype the email to delete, or anything else to cancel: "
          typed="$ANSWER"
          if [ "$typed" = "$CHOSEN_EMAIL" ]; then
            cli delete "$CHOSEN_EMAIL" && echo "Deleted."
          else
            echo "Cancelled. Nothing was changed."
          fi
        fi
        ;;
      0 | "") return ;;
      *) echo "Choose a number from the list." ;;
    esac
  done
}

# ---- Backups -----------------------------------------------------------------------------------
# Lists Nextcloud's backups and downloads the chosen one into backups/. Credentials reach curl through
# a private stream rather than the command line, where other accounts could see them.
fetch_from_nextcloud() {
  local url user pass folder dav listing names reply i=0
  url="$(env_get BACKUP_NEXTCLOUD_URL)"; url="${url%/}"
  user="$(env_get BACKUP_NEXTCLOUD_USER)"
  pass="$(env_get BACKUP_NEXTCLOUD_APP_PASSWORD)"
  folder="$(env_get BACKUP_NEXTCLOUD_FOLDER)"
  if [ -z "$url" ]; then echo "No Nextcloud is configured."; return 1; fi
  dav="$url/remote.php/dav/files/$user/${folder:-Readeez-backups}"
  listing="$(curl -sS --fail --max-time 60 --config <(printf 'user = "%s:%s"\n' "$user" "$pass") -X PROPFIND -H 'Depth: 1' "$dav")" || { echo "Couldn't read the Nextcloud folder."; return 1; }
  # Pulls names like readeez-v1.0.0-20261104-030000.tar.gz.gpg out of the XML reply, newest first.
  mapfile -t names < <(printf '%s' "$listing" | grep -oE 'readeez-v[0-9A-Za-z.]+-[0-9]{8}-[0-9]{6}\.tar\.gz\.gpg' | sort -u \
    | sed -E 's/^(.*-)([0-9]{8}-[0-9]{6})(\.tar\.gz\.gpg)$/\2 \1\2\3/' | sort -r | cut -d' ' -f2)
  if [ "${#names[@]}" = 0 ]; then echo "No backups found there."; return 1; fi
  for reply in "${names[@]}"; do i=$((i + 1)); printf '%3d  %s\n' "$i" "$reply"; done
  ask "Download which? Number, or Enter to cancel: "
  reply="$ANSWER"
  if [[ "$reply" =~ ^[0-9]+$ ]] && [ "$reply" -ge 1 ] && [ "$reply" -le "${#names[@]}" ]; then
    local name="${names[$((reply - 1))]}"
    (umask 077; mkdir -p backups; curl -sS --fail --max-time 900 --config <(printf 'user = "%s:%s"\n' "$user" "$pass") -o "backups/$name" "$dav/$name") \
      && echo "Saved to server/backups/$name" || echo "The download failed."
  fi
}

# Offers the local backups, and runs restore.sh on the chosen one. That script shows the version, asks
# for typed confirmation, and takes a safety backup first.
restore_menu() {
  local files reply i=0
  mapfile -t files < <(ls -1t backups/readeez-v*.tar.gz.gpg 2> /dev/null)
  if [ "${#files[@]}" = 0 ]; then echo "No backups on this machine. Choose \"Download a backup from Nextcloud\" first."; return; fi
  for reply in "${files[@]}"; do i=$((i + 1)); printf '%3d  %s\n' "$i" "$(basename "$reply")"; done
  ask "Restore which? Number, or Enter to cancel: "
  reply="$ANSWER"
  if [[ "$reply" =~ ^[0-9]+$ ]] && [ "$reply" -ge 1 ] && [ "$reply" -le "${#files[@]}" ]; then
    bash ./restore.sh "${files[$((reply - 1))]}"
  fi
}

menu_backups() {
  local choice
  while true; do
    heading "Backups"
    echo "  1  Back up now"
    echo "  2  List backups on this machine"
    echo "  3  Download a backup from Nextcloud"
    echo "  4  Restore a backup"
    echo "  5  View the nightly backup log"
    echo "  0  Back"
    ask "> "
    choice="$ANSWER"
    case "$choice" in
      1)
        bash ./backup.sh > /dev/null
        case "$?" in
          0) printf '%sBackup complete.%s\n' "$GREEN" "$OFF" ;;
          3) printf '%sBackup saved here, but its Nextcloud copy failed.%s\n' "$YELLOW" "$OFF" ;;
          *) printf '%sThe backup failed.%s\n' "$RED" "$OFF" ;;
        esac
        ;;
      2) ls -1ht backups/readeez-v*.tar.gz.gpg 2> /dev/null || echo "None yet." ;;
      3) fetch_from_nextcloud ;;
      4) restore_menu ;;
      5) tail -n 40 backups/backup.log 2> /dev/null || echo "No log yet." ;;
      0 | "") return ;;
      *) echo "Choose a number from the list." ;;
    esac
  done
}

# ---- Updates -----------------------------------------------------------------------------------
# Shows the versions, and runs update.sh on the chosen one. That script checks for uncommitted changes
# and a recorded security approval, backs up, deploys and verifies.
menu_update() {
  local running newest target
  git -C "$REPO_ROOT" fetch --tags --quiet origin 2> /dev/null || echo "Couldn't reach GitHub; showing the versions already known."
  running="$(cli version 2> /dev/null || echo unknown)"
  newest="$(git -C "$REPO_ROOT" tag -l 'v*' --sort=-v:refname | head -n 1)"
  heading "Update or roll back"
  echo "  Running: v$running"
  echo "  Newest:  ${newest:-none}"
  echo "  Available versions:"
  git -C "$REPO_ROOT" tag -l 'v*' --sort=-v:refname | head -n 10 | sed 's/^/    /'
  echo
  echo "  Going back to an older version restores the code only, not the database. If its database"
  echo "  layout differs (see CHANGELOG.md), you may also need to restore a backup from that version,"
  echo "  which discards everything added since."
  ask "Version to deploy [$newest], or 0 to cancel: "
  target="$ANSWER"
  target="${target:-$newest}"
  [ "$target" != 0 ] && [ -n "$target" ] || return
  # Only an exact version shape reaches the script.
  if [[ ! "$target" =~ ^v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]]; then echo "That isn't a version, e.g. v1.2.3."; return; fi
  confirm_word "$target" && bash ./update.sh "$target"
}

# ---- Logs and health ---------------------------------------------------------------------------
menu_logs() {
  local choice
  while true; do
    heading "Logs"
    echo "  1  Last 100 lines"
    echo "  2  Warnings and errors only"
    echo "  3  Follow live (Ctrl+C to stop)"
    echo "  4  Database logs"
    echo "  0  Back"
    ask "> "
    choice="$ANSWER"
    case "$choice" in
      1) docker compose logs --no-log-prefix --tail 100 api < /dev/null ;;
      2) docker compose logs --no-log-prefix --tail 2000 api 2>&1 < /dev/null | grep -E ' (WARN|ERROR) \[' | tail -n 100 ;;
      # In a subshell with Ctrl+C restored, so it stops the log and not the whole panel.
      3) (trap - INT; docker compose logs --no-log-prefix --tail 20 -f api) ;;
      4) docker compose logs --no-log-prefix --tail 50 postgres < /dev/null ;;
      0 | "") return ;;
      *) echo "Choose a number from the list." ;;
    esac
  done
}

show_health() {
  heading "Containers"
  docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' < /dev/null
  heading "API"
  if api_up; then printf '  %sResponding, and its database works.%s\n' "$GREEN" "$OFF"; else printf '  %sNot responding.%s\n' "$RED" "$OFF"; fi
  heading "Disk"
  df -h "$SERVER_DIR" | tail -n 1 | awk '{print "  " $4 " free of " $2 " (" $5 " used)"}'
  printf '  Local backups: %s\n' "$(du -sh backups 2> /dev/null | cut -f1)"
}

# Shows the settings. Anything secret shows only whether it's set.
show_settings() {
  local name
  heading "Settings (server/.env)"
  for name in READEEZ_PORT READEEZ_BIND TRUST_PROXY PUBLIC_URL CORS_ALLOWED_ORIGINS NEXTCLOUD_ALLOWED_PRIVATE_HOSTS BACKUP_NEXTCLOUD_URL BACKUP_NEXTCLOUD_USER BACKUP_NEXTCLOUD_FOLDER BACKUP_KEEP_LOCAL BACKUP_KEEP_REMOTE UPDATE_CHECK_REPO; do
    printf '  %-34s %s\n' "$name" "$(env_get "$name")"
  done
  for name in POSTGRES_PASSWORD SECRETS_KEY BACKUP_PASSPHRASE BACKUP_NEXTCLOUD_APP_PASSWORD; do
    if [ -n "$(env_get "$name")" ]; then printf '  %-34s set\n' "$name"; else printf '  %-34s %snot set%s\n' "$name" "$YELLOW" "$OFF"; fi
  done
  heading "Scheduled jobs"
  crontab -l 2> /dev/null | grep -E '# readeez-(backup|agent)$' | sed -E 's/^([^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+) .*# (.*)$/  \1  \2/' || true
  [ -n "$(crontab -l 2> /dev/null | grep -E '# readeez-' || true)" ] || echo "  None. Choose \"Schedule\" from the main menu."
}

# ---- Main menu ---------------------------------------------------------------------------------
while true; do
  # Clears only a real terminal, so piped output stays readable.
  if [ -t 1 ]; then clear; fi
  show_status
  heading "Menu"
  echo "  1  Accounts"
  echo "  2  Backups and restore"
  echo "  3  Update or roll back"
  echo "  4  Logs"
  echo "  5  Health"
  echo "  6  Settings"
  echo "  7  Check security of the live server"
  echo "  8  Schedule nightly backups and the helper"
  echo "  9  Start or restart the server"
  echo "  0  Exit"
  ask "> "
  CHOICE="$ANSWER"
  case "$CHOICE" in
    1) menu_accounts ;;
    2) menu_backups ;;
    3) menu_update; pause ;;
    4) menu_logs ;;
    5) show_health; pause ;;
    6) show_settings; pause ;;
    7)
      URL="$(env_get PUBLIC_URL)"
      if [ -n "$URL" ]; then bash "$REPO_ROOT/scripts/security-check.sh" --live "$URL"; else echo "PUBLIC_URL isn't set in server/.env."; fi
      pause
      ;;
    8) bash ./install-cron.sh; pause ;;
    9) docker compose up -d < /dev/null; pause ;;
    0) exit 0 ;;
    *) ;;
  esac
done
