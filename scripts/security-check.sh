#!/usr/bin/env bash
# scripts/security-check.sh: the release security gate. It runs every check, prints a
# PASS / FAIL / NOT RUN summary, and saves a report to security-reports/, which is gitignored
# because reports describe unfixed weaknesses and this repo is public. A check that can't run is
# NOT RUN, never silently skipped or counted as a pass. The developer reviews the results and
# approves them before any commit, push, tag or deploy.
#
# Usage:
#   npm run security                                   # the full pre-release gate
#   npm run security -- --commit                       # the same, for approving a commit: fails on uncommitted files
#   scripts/security-check.sh --live https://your.url  # post-deploy checks of a live server
#
# Exit code: 0 if nothing failed, 1 if anything failed or didn't run, 2 for bad usage.
#
# The scanners run in pinned Docker images. Files are streamed in as a tar archive rather than
# mounted, because Docker Desktop's file sharing is slow on synced folders such as Nextcloud.

# -u: an unset variable is an error. pipefail: a pipeline fails if any part fails. Not -e,
# because one failing check must not stop the others.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

SEMGREP_IMAGE="semgrep/semgrep:1.180.0"
SHELLCHECK_IMAGE="koalaman/shellcheck-alpine:v0.11.0"

LIVE_URL=""
REQUIRE_CLEAN=0
case "${1:-}" in
  --commit) REQUIRE_CLEAN=1 ;;
  --live) LIVE_URL="${2:-}"; [ -n "$LIVE_URL" ] || { echo "--live needs a URL" >&2; exit 2; } ;;
  "") ;;
  *) echo "Usage: security-check.sh [--commit | --live URL]" >&2; exit 2 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SECTIONS="$TMP/sections.md"
: > "$SECTIONS"
R_NAME=(); R_STATUS=(); R_DETAIL=()
FAILED=0

have() { command -v "$1" > /dev/null 2>&1; }
# Docker on Windows' Git Bash rewrites anything that looks like a path; this stops that.
dockr() { MSYS_NO_PATHCONV=1 docker "$@"; }

# Converts a path into the form Node understands on Windows. Elsewhere it's unchanged.
native() { if have cygpath; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# Records one check's result, and prints it as it happens, with elapsed seconds.
# In: name, status, detail. NOT RUN blocks the gate too: an unknown isn't a pass.
record() {
  R_NAME+=("$1"); R_STATUS+=("$2"); R_DETAIL+=("$3")
  if [ "$2" != "PASS" ]; then FAILED=1; fi
  printf '  %-8s %-32s %s  [%ss]\n' "$2" "$1" "$3" "$SECONDS"
}

# Appends a titled section to the report. In: title, and a file or literal text.
add_section() {
  printf '\n## %s\n\n' "$1" >> "$SECTIONS"
  if [ -f "${2:-}" ]; then cat "$2" >> "$SECTIONS"; else printf '%s\n' "${2:-}" >> "$SECTIONS"; fi
}

# Runs the parser on one scanner's output and records its verdict.
# In: check name, scanner kind, output file.
parse_and_record() {
  local md="$TMP/$2-$RANDOM.md" line
  line="$(node scripts/lib/security-parse.mjs "$2" "$(native "$3")" "$(native "$md")")"
  record "$1" "${line%%$'\t'*}" "${line#*$'\t'}"
  add_section "$1" "$md"
}

# Lists tracked and new files under the given paths, but never gitignored ones, so .env files
# and node_modules are never sent anywhere.
repo_files() { git ls-files -co --exclude-standard -- "$@" | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done; }

# Writes the report. In: output file and title.
write_report() {
  mkdir -p security-reports
  {
    echo "# $2"; echo; echo "$HEADER"; echo
    echo "| Check | Result | Detail |"; echo "|---|---|---|"
    for i in "${!R_NAME[@]}"; do echo "| ${R_NAME[$i]} | ${R_STATUS[$i]} | ${R_DETAIL[$i]//|/\\|} |"; done
    cat "$SECTIONS"
  } > "$1"
}

# ---- Post-deploy mode: checks a running server from outside, as an attacker would see it ---
live_checks() {
  local url="${LIVE_URL%/}" h code bad="" missing="" probed=0 p
  case "$url" in
    https://*) record "HTTPS URL" PASS "served over HTTPS" ;;
    *) record "HTTPS URL" FAIL "not https://, and production must be HTTPS only" ;;
  esac

  # Up, with a working database. curl also verifies the TLS certificate and hostname here.
  if curl -s --max-time 15 "$url/api/health" | grep -q '"status":"ok"'; then
    record "Health and TLS" PASS "ok, and the certificate is valid"
  else
    record "Health and TLS" FAIL "no ok status (server down, or a bad certificate)"
  fi

  h="$(curl -s --max-time 15 -D - -o /dev/null "$url/api/health" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  grep -q '^strict-transport-security:' <<<"$h" || missing+=" HSTS"
  grep -q '^x-content-type-options: nosniff' <<<"$h" || missing+=" nosniff"
  grep -qE "^content-security-policy:.*frame-ancestors 'none'" <<<"$h" || missing+=" frame-ancestors"
  if grep -q '^x-powered-by:' <<<"$h"; then missing+=" (X-Powered-By present)"; fi
  if [ -z "$missing" ]; then record "Security headers" PASS "HSTS, nosniff, framing blocked"; else record "Security headers" FAIL "missing:$missing"; fi

  # Protected routes must refuse anonymous requests.
  for p in /api/auth/me /api/nextcloud /api/admin/users /api/admin/status /api/admin/logs; do
    probed=$((probed + 1))
    code="$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$url$p")"
    [ "$code" = "401" ] || bad+=" $p=$code"
  done
  code="$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$url/api/sync")"
  probed=$((probed + 1))
  [ "$code" = "401" ] || bad+=" /api/sync=$code"
  if [ -z "$bad" ]; then record "Auth required" PASS "$probed protected routes answer 401"; else record "Auth required" FAIL "not 401:$bad"; fi

  # No headers means no answer, which must not read as "restricted".
  h="$(curl -s --max-time 15 -D - -o /dev/null -H 'Origin: https://attacker.example' "$url/api/health" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  if [ -z "$h" ]; then record "CORS restricted" FAIL "no response"
  elif grep -qE '^access-control-allow-origin: (\*|https://attacker\.example)' <<<"$h"; then record "CORS restricted" FAIL "a foreign origin was allowed"
  else record "CORS restricted" PASS "a foreign origin isn't allowed"; fi

  # The limiter announces itself with RateLimit headers. An empty request checks no password.
  h="$(curl -s --max-time 15 -D - -o /dev/null -X POST -H 'Content-Type: application/json' -d '{}' "$url/api/auth/login" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  if grep -q '^ratelimit' <<<"$h"; then record "Sign-in rate limiting" PASS "limiter active"; else record "Sign-in rate limiting" FAIL "no RateLimit headers"; fi

  # The database must never be reachable directly.
  local host="${url#*://}"; host="${host%%[/:]*}"
  if (exec 3<>"/dev/tcp/$host/5432") 2> /dev/null; then record "Database port closed" FAIL "port 5432 answers on $host"; else record "Database port closed" PASS "port 5432 isn't reachable"; fi
}

TS="$(date +%Y%m%d-%H%M%S)"
if [ -n "$LIVE_URL" ]; then
  have curl || { echo "curl is required" >&2; exit 2; }
  HEADER="Target: $LIVE_URL · $(date '+%Y-%m-%d %H:%M %Z')"
  echo "Post-deploy security checks against $LIVE_URL"
  live_checks
  HOST="$(printf '%s' "$LIVE_URL" | sed -E 's#^https?://##; s#[/:].*##')"
  REPORT="security-reports/live-$HOST-$TS.md"
  write_report "$REPORT" "Post-deploy security check: $HOST"
  echo; echo "Report: $REPORT"
  [ "$FAILED" = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
  exit "$FAILED"
fi

# ---- Full gate --------------------------------------------------------------------------
VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short HEAD 2> /dev/null || echo uncommitted)"
HEADER="Version $VERSION · commit $COMMIT · $(date '+%Y-%m-%d %H:%M %Z')"
echo "Security gate for Readeez v$VERSION ($COMMIT)"
DOCKER_OK=0
if docker info > /dev/null 2>&1; then DOCKER_OK=1; fi

# Every check below reads the files on disk. Uncommitted changes would make its results describe something other than
# the commit in the report, and an approval is tied to that commit. Only checked with --commit, so the gate can still be
# run on work in progress before committing.
if [ "$REQUIRE_CLEAN" = 1 ]; then
  if [ -z "$(git status --porcelain)" ]; then
    record "Results match the commit" PASS "no uncommitted files"
  else
    record "Results match the commit" FAIL "$(git status --porcelain | wc -l | tr -d ' ') uncommitted files: results don't describe $COMMIT"
  fi
fi

# 0. The version number must match everywhere it appears.
SV="$(node -p "require('./server/package.json').version")"
AV="$(node -p "require('./app.json').expo.version")"
if [ "$VERSION" = "$SV" ] && [ "$VERSION" = "$AV" ]; then
  record "Versions in lockstep" PASS "app, app.json and server are all $VERSION"
else
  record "Versions in lockstep" FAIL "package.json $VERSION, app.json $AV, server $SV"
fi

# 1a. Semgrep: pattern-based security analysis of all source.
if [ "$DOCKER_OK" = 1 ]; then
  repo_files . | grep -vE '(^|/)(package-lock\.json)$|^assets/' | tar -cf - -T - 2> /dev/null \
    | dockr run --rm -i --entrypoint sh "$SEMGREP_IMAGE" -c \
      'mkdir -p /src && tar -xf - -C /src && cd /src && semgrep scan --quiet --json --metrics=off --config p/owasp-top-ten --config p/javascript --config p/nodejs --config p/secrets . ' \
      > "$TMP/semgrep.json" 2> "$TMP/semgrep.err"
  parse_and_record "Semgrep (SAST)" semgrep "$TMP/semgrep.json"
else
  record "Semgrep (SAST)" "NOT RUN" "Docker isn't available"
fi

# 1b. ESLint with its security plugin.
if [ -x node_modules/.bin/eslint ]; then
  npx eslint --format json . > "$TMP/eslint.json" 2> "$TMP/eslint.err"
  parse_and_record "ESLint security rules" eslint "$TMP/eslint.json"
else
  record "ESLint security rules" "NOT RUN" "run npm ci first"
fi

# 1c. ShellCheck on every shell script.
if [ "$DOCKER_OK" = 1 ]; then
  repo_files '*.sh' > "$TMP/sh.txt"
  if tar -cf - -T "$TMP/sh.txt" | dockr run --rm -i --entrypoint sh "$SHELLCHECK_IMAGE" -c \
      'mkdir -p /src && tar -xf - -C /src && cd /src && find . -name "*.sh" -exec shellcheck {} +' > "$TMP/shellcheck.txt" 2>&1; then
    record "ShellCheck" PASS "$(wc -l < "$TMP/sh.txt" | tr -d ' ') scripts clean"
  else
    record "ShellCheck" FAIL "see the report"
    add_section "ShellCheck" "$TMP/shellcheck.txt"
  fi
else
  record "ShellCheck" "NOT RUN" "Docker isn't available"
fi

# 2. Dependency vulnerabilities, separately for the app and the server.
npm audit --json > "$TMP/audit-app.json" 2> /dev/null
parse_and_record "npm audit (app)" audit "$TMP/audit-app.json"
(cd server && npm audit --json) > "$TMP/audit-server.json" 2> /dev/null
parse_and_record "npm audit (server)" audit "$TMP/audit-server.json"

# Currency is for information. Majors are a deliberate decision, and Expo pins some packages.
{ echo '```'; npm outdated 2> /dev/null; (cd server && npm outdated 2> /dev/null); echo '```'; } > "$TMP/outdated.md"
add_section "Outdated packages (information only)" "$TMP/outdated.md"

# 3. Secrets, in the working tree, the staged changes, and the whole history.
if have gitleaks; then
  mkdir -p "$TMP/tree"
  repo_files . | tar -cf - -T - 2> /dev/null | tar -xf - -C "$TMP/tree"
  gitleaks dir "$(native "$TMP/tree")" --no-banner --exit-code 0 --report-format json --report-path "$(native "$TMP/gl-tree.json")" > /dev/null 2>&1
  parse_and_record "gitleaks (working tree)" gitleaks "$TMP/gl-tree.json"
  gitleaks git . --staged --no-banner --exit-code 0 --report-format json --report-path "$(native "$TMP/gl-staged.json")" > /dev/null 2>&1
  parse_and_record "gitleaks (staged)" gitleaks "$TMP/gl-staged.json"
  if git rev-parse HEAD > /dev/null 2>&1; then
    gitleaks git . --no-banner --exit-code 0 --report-format json --report-path "$(native "$TMP/gl-hist.json")" > /dev/null 2>&1
    parse_and_record "gitleaks (history)" gitleaks "$TMP/gl-hist.json"
  else
    record "gitleaks (history)" PASS "no commits yet"
  fi
else
  record "gitleaks" "NOT RUN" "gitleaks isn't installed"
fi

# Public repo: real internal names must not be committed. The patterns live in a gitignored
# file, one regular expression per line, because listing them here would publish them.
repo_files . | grep -vE '(^|/)package-lock\.json$|^assets/' > "$TMP/all.txt"
if [ ! -s .security-private-patterns ]; then
  record "Public repo sanitized" "NOT RUN" "no .security-private-patterns file on this machine"
elif xargs -d '\n' grep -nE -f .security-private-patterns < "$TMP/all.txt" > "$TMP/sanitize.txt" 2> /dev/null; then
  record "Public repo sanitized" FAIL "$(wc -l < "$TMP/sanitize.txt" | tr -d ' ') private references"
  add_section "Public repo sanitized" "$TMP/sanitize.txt"
else
  record "Public repo sanitized" PASS "no private hosts, addresses or emails"
fi

# Pulls the totals out of the test runner's output, e.g. "228 passed (228)". In: the output file.
test_summary() { grep -E '^\s*Tests ' "$1" | sed -E 's/^\s*Tests +//'; }

# Says whether any test was skipped. A skipped security test proves nothing, so it mustn't count as a pass.
# In: the output file. Out: success if something was skipped.
skipped_tests() { grep -qE '^\s*Tests .*(skipped|todo)' "$1"; }

# 4. Project tests: the server's suite is the security tests, run against real Postgres.
if [ "$DOCKER_OK" = 1 ]; then
  if (cd server && NO_COLOR=1 npx vitest run --reporter=verbose) > "$TMP/server-tests.txt" 2>&1 && ! skipped_tests "$TMP/server-tests.txt"; then
    record "Server tests (real Postgres)" PASS "$(test_summary "$TMP/server-tests.txt")"
  else
    record "Server tests (real Postgres)" FAIL "$(test_summary "$TMP/server-tests.txt")"
  fi
  { echo '```'; grep -E '^\s*(✓|×|FAIL)|^\s*Tests ' "$TMP/server-tests.txt"; echo '```'; } > "$TMP/server-tests.md"
  add_section "Server tests by area" "$TMP/server-tests.md"
else
  record "Server tests (real Postgres)" "NOT RUN" "Docker isn't available"
fi
if NO_COLOR=1 npx vitest run > "$TMP/app-tests.txt" 2>&1 && ! skipped_tests "$TMP/app-tests.txt"; then
  record "App logic tests" PASS "$(test_summary "$TMP/app-tests.txt")"
else
  record "App logic tests" FAIL "$(test_summary "$TMP/app-tests.txt")"
fi

# 5. The AI diff review can't be scripted, so it's listed rather than implied.
record "AI diff review" "NOT RUN" "manual step: run /security-review on the pending change"
# A manual step that's merely pending shouldn't make the scripted result look like a failure.
[ "${#R_STATUS[@]}" -gt 0 ] && FAILED=0
for i in "${!R_STATUS[@]}"; do
  if [ "${R_STATUS[$i]}" != "PASS" ] && [ "${R_NAME[$i]}" != "AI diff review" ]; then FAILED=1; fi
done

mkdir -p security-reports
REPORT="security-reports/v$VERSION-$COMMIT-$TS.md"
write_report "$REPORT" "Security gate: Readeez v$VERSION"
echo; echo "Report: $REPORT"
[ "$FAILED" = 0 ] && echo "RESULT: PASS (the AI diff review is still to do)" || echo "RESULT: FAIL"
exit "$FAILED"
