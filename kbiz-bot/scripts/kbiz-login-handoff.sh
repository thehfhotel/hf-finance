#!/usr/bin/env bash
#
# Pre-warm the K BIZ session by hand (publish a QR, wait for the scan).
#
# WHY A WRAPPER. The kbiz-bot container IS the watch loop: every 30 s it opens
# the persistent Chromium profile in /app/kbiz-bot/browser-data. A second
# process opening that same profile deadlocks on Chromium's user-data-dir lock,
# and two concurrent K BIZ sessions get each other signed out. So the only safe
# pre-warm is: pause the watcher, run src/login.ts as a ONE-OFF container
# against the same volumes, unpause — whatever happens.
#
# This script runs ON THE HOST (evergreen), not inside the image: the image
# copies only kbiz-bot/src, so this script is deliberately host-only. The
# deploy tarball carries docker-compose.yml and nothing else, so there is NO
# copy of it on the box either — send it over first (it cd's to $COMPOSE_DIR
# itself, so it does not matter where it lands):
#
#   scp kbiz-bot/scripts/kbiz-login-handoff.sh evergreen:~/
#   ssh evergreen bash '~/kbiz-login-handoff.sh'
#
# Then open the QR page (KBIZ_QR_PAGE_URL, default
# https://payroll.thehfhotel.org/kbiz/login-qr) on a computer and scan it with
# the K BIZ phone app within 5 minutes. Slack gets the same link.
#
# The pause takes effect immediately, wherever the watcher is. The arm-lock
# check below keeps it off a live money flow (there is a small read-then-pause
# window); if it lands mid-batch the profile is still held and the one-off run
# simply fails to launch Chromium — loud and harmless: wait for the batch to
# finish and run this again. Nothing here WRITES the arm lock, the queue or any
# money path; it does READ the arm lock and refuse to pause while an approval
# push is live, because freezing the watcher mid-money-flow is not what "loud
# and harmless" describes.
#
# It needs to run as root: the compose dir's `.env` is 0600 deploy-owned on
# evergreen and `docker compose` must read it to build the one-off container's
# environment. Invoked as a normal user it re-executes itself under `sudo -n`
# (passwordless for the operator account) — so a plain
# `ssh evergreen bash '~/kbiz-login-handoff.sh'` is enough.
set -euo pipefail

COMPOSE_DIR="${KBIZ_COMPOSE_DIR:-/home/deploy/payroll-production}"
SERVICE="${KBIZ_SERVICE:-kbiz-bot}"
ARM_LOCK="${COMPOSE_DIR}/data/kbiz-arm-lock.json"

if [ ! -r "$COMPOSE_DIR/.env" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    exec sudo -n env KBIZ_COMPOSE_DIR="$COMPOSE_DIR" KBIZ_SERVICE="$SERVICE" bash "$0" "$@"
  fi
  echo "⛔ $COMPOSE_DIR/.env is not readable even as root — is this the compose dir?" >&2
  exit 1
fi

cd "$COMPOSE_DIR"

# ── Refuse while a push is live ───────────────────────────────────────────
# The arm lock (kbiz-bot/src/lib/arm-gate.ts) is live iff state is "armed" and
# now < pushExpiresAt. A conservative lock is taken BEFORE the arming click, so
# "armed" can also mean "a flow is mid-form" — either way the watcher is inside
# a money flow and must not be frozen there. Read-only: this never writes the
# lock, and it never releases one.
if [ -f "$ARM_LOCK" ] && grep -q '"state"[[:space:]]*:[[:space:]]*"armed"' "$ARM_LOCK"; then
  expires="$(sed -n 's/.*"pushExpiresAt"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ARM_LOCK" | head -n1)"
  expires_epoch="$(date -d "$expires" +%s 2>/dev/null || echo 0)"
  if [ "$expires_epoch" -gt "$(date +%s)" ]; then
    echo "⛔ a K BIZ approval push is armed and still live (until $expires)." >&2
    echo "   Not pausing $SERVICE mid-money-flow. Tap (or ignore) it in the K BIZ app," >&2
    echo "   let the flow resolve, then run this again." >&2
    exit 1
  fi
  echo "ℹ an armed arm lock is on disk but its push window closed at $expires — continuing."
fi

paused=0
unpause() {
  if [ "$paused" = "1" ]; then
    echo "→ unpausing $SERVICE"
    docker compose unpause "$SERVICE" || echo "⚠ could not unpause $SERVICE — do it by hand: docker compose unpause $SERVICE"
  fi
}
trap unpause EXIT INT TERM

# Printed BEFORE the pause on purpose: if this shell is SIGKILLed or the ssh
# session drops, the EXIT trap never runs and the watcher stays paused. This
# line is then the operator's recovery instruction, already in their scrollback.
echo "ℹ if this session dies before it finishes, recover by hand (both halves):"
echo "     cd $COMPOSE_DIR && docker compose unpause $SERVICE"
echo "     docker compose ps --all | grep -- '-$SERVICE-run-'   # an orphaned one-off still holds the profile: docker rm -f <it>"
echo "→ pausing $SERVICE (the watch loop must not hold the browser profile)"
docker compose pause "$SERVICE"
paused=1

echo "→ running the login handoff as a one-off container"
# --no-deps: never start/restart payroll as a side effect.
# -T: no TTY — this is a log-and-wait run, driven from Slack + the QR page.
# --rm: the one-off container is disposable; the session it warms lives in the
#       kbiz-bot-profile volume, which is what the watcher reads back.
docker compose run --rm --no-deps -T "$SERVICE" node --import tsx src/login.ts

echo "✅ login handoff finished"
