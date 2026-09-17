# CR-2026-09-17 — K BIZ QR login handoff (Cloudflare-gated route)

## Why

Since June 2026 K BIZ requires a scan from the K BIZ phone app after user/pass on
EVERY web login (live-verified 2026-09-17: after `#loginBtn` the bank redirects to
`/authen/loginQR.do?cmd=…`, shows `img.qrcode` — a 150×150 `data:image/png` — with
"กรุณาทำรายการภายใน 05:55 นาที", and redirects itself to
`/menu/account/account-summary` once the app confirms). The bot's `loginFlow`
waits 60 s for the URL to leave `/authen` and then throws, so every re-login
crashes the first queue item of a batch and leaves the conservative arm lock
standing for ~10 min. Unattended re-login is impossible by bank policy; a human
must scan. This CR gives the bot a handoff: it publishes the QR to a directory
both containers already mount, payroll-form serves it on a Cloudflare-Access-gated
route, Slack carries the link.

Owner decisions (2026-09-17): Cloudflare-gated route on `payroll.thehfhotel.org`
(whole-hostname Access app, no Cloudflare change); edge gate only (no origin JWT
check, same posture as the rest of payroll-form); page visible to everyone the
payroll hostname admits; no session keepalive yet (measure the bank's idle timeout
on real batches first).

## Contract (locked before fan-out — both sides build against this)

**Directory.** kbiz-bot writes to `KBIZ_QR_DIR` (default `resolve("..", "data",
"qr-login")` = `/app/data/qr-login` in the container). payroll-form reads
`process.env.KBIZ_QR_DIR ?? "data/qr-login"` (cwd `/app` → the same path). Host
path: `/home/deploy/payroll-production/data/qr-login` — the payroll-stack-local
`./data` bind, NOT the cross-stack `/home/deploy/kbiz-queue` mount (no nested
bind covers `qr-login/`). The bot creates the directory on first use.

**Files** (both written atomically: write `<name>.tmp` then rename):

- `current.png` — the PNG bytes decoded from the page's `img.qrcode` data URI
  (never a screenshot). Present ONLY while `status` is `waiting`; removed on every
  other transition.
- `state.json` —
  ```json
  {
    "status": "waiting" | "ok" | "expired" | "error",
    "reason": "string — why the login was needed, e.g. '2 approved item(s)'",
    "attempt": 1,
    "capturedAt": "ISO-8601 or null",
    "expiresAt": "ISO-8601 or null — capturedAt + 5 min 55 s",
    "updatedAt": "ISO-8601",
    "message": "short human text; masked (no account numbers, no query strings)"
  }
  ```
  `waiting`: a QR is available; `attempt` increments for each fresh QR the bank
  shows. `ok`: dashboard confirmed. `expired`: no accepted scan before the
  deadline, or the bank bounced back to the credentials form. `error`:
  unexpected failure. payroll-form synthesizes `{"status":"idle"}` when the file
  is missing.

**Slack** (bot's existing incoming webhook, text only):

- on the first QR of a login and on each fresh QR at most once per 60 s:
  `:lock: kbiz-bot: K BIZ ต้องสแกน QR เพื่อเข้าสู่ระบบ (<reason>, QR #<attempt>) — เปิด <KBIZ_QR_PAGE_URL> บนคอมพิวเตอร์ แล้วสแกนด้วยแอป K BIZ ภายใน 5 นาที`
- success: `:white_check_mark: kbiz-bot: เข้าสู่ระบบ K BIZ แล้ว (<reason>)`
- timeout: `:hourglass: kbiz-bot: ไม่มีการสแกนใน 6.5 นาที — งานยังรออยู่ จะขอใหม่ใน 10 นาที`

**Env.** `KBIZ_QR_PAGE_URL` (bot; default
`https://payroll.thehfhotel.org/kbiz/login-qr`), `KBIZ_QR_DIR` (both; optional).
No new secrets.

**Routes (payroll-form, all `cache-control: private, no-store`).**

- `GET /kbiz/login-qr` — HTML page. Shows the state and, while `waiting`, the QR
  image from `/kbiz/login-qr.png?t=<updatedAt>`; polls `/kbiz/login-qr/state.json`
  every 5 s and swaps the image when `updatedAt` changes. Thai copy first.
- `GET /kbiz/login-qr.png` — `200 image/png` only when `status === "waiting"` and
  `current.png` exists; otherwise `404`.
- `GET /kbiz/login-qr/state.json` — `200 application/json`; `{"status":"idle"}`
  when there is no state file.
  Auth: the whole-hostname Cloudflare Access app on `payroll.thehfhotel.org`
  (edge gate), like every other payroll-form page.

**Login policy (bot).** `gotoAuthenticated(page, url, opts?)` and
`ensureLoggedIn(page, opts?)` take `{ onQr: "handoff" | "refuse" }`, default
`"refuse"`. `loginFlow` waits (60 s) for EITHER a non-`/authen` URL OR
`loginQR.do`. On `loginQR.do`: `"refuse"` throws `QrLoginRequiredError` at once
(no 60 s wait); `"handoff"` runs the handoff and either returns logged in or
throws `QrLoginTimeoutError`. Both error classes live in the pure core module so
callers can `instanceof` them.

**Handoff (bot, pure core + thin driver).** Core: `runQrHandoff(view, opts)` over
thunks `{ now(), sleep(ms), url(), qrDataUri(), loginFormVisible(),
confirmDashboard(), writePng(bytes), writeState(state), removePng(), notify(text) }`.
Loop every 2 s up to 6.5 min: fresh data URI → decode (must be `data:image/png;
base64,`), write PNG + `waiting` state, notify (rate-limited 60 s); URL left
`/authen` → `confirmDashboard()` (driver: goto the dashboard, 12×500 ms
stabilisation exactly like `gotoAuthenticated`'s poll, URL contains `/menu/`, no
`#userName`) → `ok`, remove PNG, notify, return; credentials form visible again →
`expired`, throw; deadline → `expired`, throw. Never resubmits credentials.

**Queue warm-up (bot).** In `processBatch`, right after `withSession` opens and
BEFORE the per-item loop / any claim / any arm-lock write:
`ensureLoggedIn(page, { onQr: "handoff" })` with reason
`"<n> approved item(s)"`. On `QrLoginTimeoutError`: Slack the timeout line,
record `lastQrFailAt`, return without touching any item (they stay `approved`).
While `now - lastQrFailAt < 10 min` the batch is skipped with one log line and
no Slack (pure `shouldRequestQr(now, lastQrFailAt, cooldownMs)`). The payroll
settlement check keeps the default `"refuse"`: a QR page makes it give up
immediately (its existing `BANK_CHECK_UNAVAILABLE` + 6-hour retry apply).

**Operator pre-warm.** `npm run login` (`src/login.ts`) uses `onQr: "handoff"`;
`kbiz-bot/scripts/kbiz-login-handoff.sh` pauses the watch container, runs
`src/login.ts` as a one-off `docker compose run --rm --no-deps -T kbiz-bot`,
unpauses in a trap — the only safe way to pre-warm while the watch loop exists.

## Tests

kbiz-bot (`bun test`, root CI runs it without playwright — the core must not
import playwright, not even `import type`): first QR writes PNG + state +
notifies; a rotated QR rewrites both, increments `attempt`, rate-limits Slack;
success → `ok`, PNG removed; deadline and bounce-to-form → `expired` + throw;
non-PNG / malformed data URI → `error` + throw; `shouldRequestQr` cooldown.
payroll-form (`bun test`, Elysia `app.handle`): idle → HTML renders "no scan
pending", PNG 404, state idle; `waiting` fixture → PNG 200 `image/png` no-store,
page contains the img; `ok`/`expired` render; nothing reads outside the fixed
filenames.

## Deploy

PR → CI (root `bun test`, kbiz-bot `bun test` + `tsc`) → merge to main →
`deploy.yml` rebuilds `payroll` + `payroll-kbiz-bot` images and recreates both
containers on evergreen. Verify live: `https://payroll.thehfhotel.org/kbiz/login-qr`
answers through Cloudflare Access with the idle state; the next real batch (or an
operator pre-warm) exercises the handoff end to end.
