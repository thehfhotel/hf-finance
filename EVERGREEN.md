# Deploying to evergreen

> **Monorepo note (2026-08-12):** this repo also carries `reimbursement/`
> (its own pipeline: `.github/workflows/deploy-reimbursement.yml` → SSH as
> `reimbursement-v2` → `/home/reimbursement-v2/production`; secrets prefixed
> `REIMB_`). Nothing below changed for payroll's own deploy.

## CI/CD via GitHub Actions

`.github/workflows/deploy.yml` mirrors the new-hotel Phase-1 pattern
(`new-hotel/docs/runbook-deploy-modernization.md`):

1. **`changes`** — `dorny/paths-filter` decides whether the payroll image,
   the kbiz-bot image, and/or the deploy step need to run. Doc-only commits
   skip everything.
2. **`build-payroll` / `build-kbiz-bot`** — GitHub-hosted runners build
   in parallel, tag `:latest` and `:<sha>`, push to `ghcr.io`. Each gated on
   its own paths-filter output.
3. **`deploy`** — runs on `ubuntu-latest`, NOT on a self-hosted runner.
   It reaches evergreen via `cloudflared access ssh --hostname %h` (same
   tunnel the operators use for daily SSH) and SSHes as the unprivileged
   `deploy` user. `deploy@evergreen`'s `authorized_keys` pins the SSH key
   to `/srv/run-deploy-payroll.sh` (forced-command); the workflow can only
   trigger that script — it cannot execute arbitrary commands on prod.
   The script unpacks `docker-compose.yml`, materialises `.env` from the
   payload, `docker compose pull && up -d`, and health-checks both
   containers.

## One-time evergreen setup

The new-hotel runbook walks through the `deploy` user creation, sshd
hardening, and key install in detail. See:

```
new-hotel/docs/runbook-deploy-modernization.md
```

Steps already done as part of new-hotel modernisation (do NOT repeat):

- `deploy` user exists, in `docker` group, `/home/deploy/.ssh/` set up
- sshd has `PasswordAuthentication no` + `KbdInteractiveAuthentication no`
- `/var/log/deploy/` exists, owned `deploy:deploy`
- evergreen host key is published as the `EVERGREEN_HOST_KEY` GH Secret

Payroll-specific additions:

```sh
# 1. Generate a NEW ed25519 key for payroll (do NOT reuse new-hotel's key —
#    each app gets its own key pinned to its own forced-command).
ssh-keygen -t ed25519 -a 100 -f /tmp/evergreen-payroll-deploy \
  -C "gh-actions@thehfhotel-payroll" -N ""

# 2. On evergreen as root: install the deploy script + migrate the prod
#    dir. `mv` (not `install -d`) preserves the existing `data/` bind-mount
#    contents (queue, roster, registered cache). The named volume
#    `payroll-production_kbiz-bot-profile` is keyed by dir basename, which
#    doesn't change, so the Chromium session survives the move.
sudo install -m 755 -o root -g root \
  /path/to/payroll/scripts/deploy/run-deploy.sh \
  /srv/run-deploy-payroll.sh
sudo mv /home/nut/payroll-production /home/deploy/payroll-production
sudo chown -R deploy:deploy /home/deploy/payroll-production

# 3. APPEND a second entry to /home/deploy/.ssh/authorized_keys.
#    Result: two distinct keys, each pinned to its own forced-command.
sudo tee -a /home/deploy/.ssh/authorized_keys > /dev/null <<'EOF'
command="/srv/run-deploy-payroll.sh",restrict ssh-ed25519 PUBLIC_KEY_FROM_STEP_1 gh-actions@thehfhotel-payroll
EOF

# 4. Symlink under /home/nut for muscle-memory parity (operators reach
#    the dir via `cd ~/payroll-production` from the nut account).
sudo ln -s /home/deploy/payroll-production /home/nut/payroll-production

# 5. Test from your laptop BEFORE flipping the workflow:
echo '{"commit_sha":"test","deploy_payload_b64":"<b64 tarball>","ghcr":{...},"env":{...}}' \
  | ssh -i /tmp/evergreen-payroll-deploy \
      -o StrictHostKeyChecking=accept-new \
      -o ProxyCommand="cloudflared access ssh --hostname %h" \
      deploy@evergreen.thehfhotel.org
# Expect: script stdout streams back, ending with `[deploy] done ... log=...`.
# If anything goes wrong, log is at /var/log/deploy/deploy-payroll-*.log on evergreen.

# 6. Delete /tmp/evergreen-payroll-deploy from the laptop after step 7.

# 7. Add GH Secrets in this repo:
#    - EVERGREEN_DEPLOY_SSH_KEY = private half from step 1
#    - EVERGREEN_HOST_KEY       = same value as new-hotel's (same host)
```

## Repository secrets

| name                        | use                                           |
| --------------------------- | --------------------------------------------- |
| `KBIZ_USERNAME`             | KBIZ login (passed into `.env` on evergreen)  |
| `KBIZ_PASSWORD`             | KBIZ login                                    |
| `SLACK_WEBHOOK_URL`         | webhook for queue notifications (optional)    |
| `READER_RESOLVE_SECRET`     | app↔central HF ID card-login secret (`X-Reader-Secret`); unset ⇒ card login dark (503) |
| `HF_ID_BASE_URL`            | central HF ID base URL (optional; default `http://192.168.100.228:5000`) |
| `HF_ID_ISSUER`              | expected card-assertion issuer (optional; default `https://id.thehfhotel.org/oidc`) |
| `EVERGREEN_DEPLOY_SSH_KEY`  | ed25519 private key for `deploy@evergreen`    |
| `EVERGREEN_HOST_KEY`        | evergreen's SSH host key (`known_hosts` pin)  |

> Set with `gh secret set NAME --body "$VALUE"` (NOT `--body -`). The
> dash form treats literal `-` as the value; pipe via stdin instead:
> `printf '%s' "$VAL" | gh secret set NAME`.

## Operations

```sh
ssh nut@evergreen
cd /home/deploy/payroll-production    # via the /home/nut symlink: cd ~/payroll-production

# tail logs of one service
docker compose logs -f payroll
docker compose logs -f kbiz-bot

# rerun list scrape inside the kbiz-bot container
docker compose exec kbiz-bot node --import tsx src/list-payroll-accounts.ts

# reset KBIZ session (force fresh login on next run)
docker compose down
docker volume rm payroll-production_kbiz-bot-profile
docker compose up -d

# inspect the most recent CI deploy
sudo less /var/log/deploy/$(ls -t /var/log/deploy/deploy-payroll-*.log | head -1)
```

## Stack overview

| service        | role                                           | image                                          |
| -------------- | ---------------------------------------------- | ---------------------------------------------- |
| `payroll-form` | Bun + Elysia web app on :3000 (host :3002)     | `ghcr.io/thehfhotel/payroll:latest`            |
| `kbiz-bot`     | Headless Chromium + Playwright queue processor | `ghcr.io/thehfhotel/payroll-kbiz-bot:latest`   |

Both share `./data` (bind-mount) for the queue, roster, and registered cache.
`kbiz-bot-profile` is a named volume holding the persistent Chromium
profile (cookies/localStorage); rebuilds preserve the KBIZ session.

After the stack is up, port `3002` on evergreen is exposed via the
Cloudflare tunnel public hostname (configured in the Cloudflare web console).

## Reimbursement → KBIZ shared queue dir (not yet switched on)

`kbiz-bot` also drives ad-hoc `transfer-other` payments queued by the
**reimbursement** app (a separate repo/stack) — see
`docs/adr/0001-kbiz-transfer-automation.md` there. That intent JSON, its
rendered voucher HTML, and the captured e-slip need to live in a dir shared
by `kbiz-bot`, `payroll-form`, and `reimbursement-api`, three containers that
may belong to different compose stacks.

The bot side reads three env vars for the shared queue (plus five optional ones
for the K BIZ login page and the resident session, below), each independently
defaulted so nothing changes until they're set:

| env var           | default (today)      | meaning                                              |
| ------------------ | --------------------- | ----------------------------------------------------- |
| `KBIZ_QUEUE_DIR`   | `../data/queue`       | where `process-queue.ts` watches for approved items    |
| `KBIZ_SLIPS_DIR`   | `../data/slips`       | where captured e-slip screenshots are written          |
| `KBIZ_SHARED_DIR`  | `../data`             | root a `transfer-other` intent's relative paths (`voucherFile`) resolve against |
| `KBIZ_QR_DIR`      | bot `../data/qr-login`, payroll-form `data/qr-login` | optional, BOTH containers: where the bot publishes the K BIZ login QR (`current.png` + `state.json`) and its session state (`session.json`), and where payroll-form writes the operator's `login.request` — same host path `/home/deploy/payroll-production/data/qr-login`, so leave it unset |
| `KBIZ_QR_PAGE_URL` | `https://payroll.thehfhotel.org/kbiz/login-qr` | optional, bot only: the link Slack sends the operator; the page is gated by the existing whole-hostname `payroll.thehfhotel.org` Cloudflare Access app (no Cloudflare change, no origin auth) |
| `KBIZ_TICK_MS`     | `5000`                | optional, bot only: how often the watch loop ticks (picks up a `login.request`, decides whether a keepalive ping is due) |
| `KBIZ_KEEPALIVE_MS`| `240000`              | optional, bot only: how often the resident K BIZ session is pinged to keep it alive (4 min) |
| `KBIZ_LOGIN_REMINDER_HHMM` | `08:30`      | optional, bot only: the Asia/Bangkok time of the once-a-day Slack reminder, sent only while the session is dead |

Since CR-2026-09-17 the bot never starts a login by itself: the page at
`KBIZ_QR_PAGE_URL` carries a **เข้าสู่ระบบ K BIZ** button the operator presses from a second
screen, which is what asks the bank for a QR.

> **Snap-Docker constraint (why these paths live under `/home/deploy`):**
> evergreen runs Docker as a snap. The confined daemon cannot use bind
> sources outside `/home` — a `/srv/...` mount fails the container start
> with `error while creating mount source path … read-only file system`,
> even when the path exists on the host. Both 2026-08-12 deploys tripped
> this and took the stacks down until the tree moved to
> `/home/deploy/kbiz-queue`. Keep every future bind source under `/home`.

`docker-compose.yml` has the switch-over already drafted, commented out, as
**nested binds** — subpaths of `${KBIZ_QUEUE_HOST_DIR:-/home/deploy/kbiz-queue}`
mounted OVER `./data/queue`, `./data/slips` and `./data/vouchers` in the
`kbiz-bot` service, plus the matching `queue` bind in the `payroll` service.
Every default in-container path keeps working in both containers, so the env
vars above stay UNSET in production.

> **Why nested binds and not `KBIZ_QUEUE_DIR`:** the bot watches exactly ONE
> queue dir, and payroll-form writes its `add-payroll` / `transfer-payroll` /
> `list-registered` items to `/app/data/queue` (its own `QUEUE_DIR` default).
> Repointing only the bot's `KBIZ_QUEUE_DIR` at a different tree makes it stop
> reading payroll's queue: every payroll request then sits at "approved"
> forever with no error anywhere. The nested binds move the PHYSICAL location
> of the one shared queue while every path both producers use stays the same.
> Tradeoff accepted: payroll queue items (salary xlsx + results) live in the
> shared dir and are readable by the reimbursement-api container (same host,
> same owner, CF-gated apps).

To flip it on:

```sh
# On evergreen, once (creates the subdirs the contract expects):
sudo mkdir -p /home/deploy/kbiz-queue/{queue,queue/archive,vouchers,slips}
sudo chown -R deploy:deploy /home/deploy/kbiz-queue   # or whichever uid the containers run as

# Move the EXISTING payroll queue contents into the shared dir so history and
# any pending items survive the switch (do this while the stack is stopped):
docker compose down
sudo rsync -a data/queue/ /home/deploy/kbiz-queue/queue/

# transfer-other.config.json (the payee book: real bank account numbers) is
# PII and must NOT live under /home/deploy/kbiz-queue above — that dir is also
# bind-mounted into reimbursement-api, and reimbursement never sends bank
# details (see kbiz-bot/README.md). Give it its own kbiz-bot-only dir:
sudo mkdir -p /home/deploy/kbiz-bot
sudo cp path/to/kbiz-bot/transfer-other.config.example.json \
  /home/deploy/kbiz-bot/transfer-other.config.json   # then edit in the real payee(s)
sudo chown -R deploy:deploy /home/deploy/kbiz-bot

# Uncomment ALL FOUR nested binds (three on kbiz-bot + one on payroll) and the
# payee-book mount in docker-compose.yml, then also bind-mount /home/deploy/kbiz-queue
# into reimbursement-api (a different repo/stack) — see that repo's
# docs/change-requests/CR-2026-08-12-kbiz-payment-automation.md.

docker compose up -d
```

Until this is done, `transfer-other` queue items simply never appear (nothing
writes them into `../data/queue` on this side); payroll's own items keep
flowing through the un-switched `./data/queue`. The payee-book mount matters
only once `transfer-other` items start arriving:
`runTransferOtherQueueItem` calls `loadTransferConfig()` on every
`transfer-other` item, so skipping that mount turns every one of them into an
immediate, repeating `config: transfer-other.config.json: not found` failure.
