# CR-2026-09-17 — K BIZ resident session, keepalive, and operator-triggered login

## Why

CR-2026-09-17-kbiz-qr-login-handoff made the bot publish the bank's login QR
and ask for a scan whenever a batch needed a login. Two facts from the owner
(2026-09-17) change the shape:

- The K BIZ app cannot scan a QR from a saved picture, so a scan always needs
  a SECOND screen (laptop / office PC) showing the code. The owner often has
  only the phone, so an unsolicited QR is usually one nobody can use.
- The owner wants to START the login from our web page when a second screen
  is at hand, with Slack only carrying the link. No QR "ready all the time".

So: the bot keeps its session alive itself, never starts a login on its own,
tells Slack when the session ends / work is waiting / it is morning and still
dead, and runs the QR handoff only when the operator presses the button on
the page.

Owner decisions (2026-09-17): keepalive yes (always-on session accepted; the
phone tap still gates every transfer); trigger on the web page (a Slack
command may come later — needs a Slack bot token, out of scope); morning
reminder 08:30 Bangkok; ping every 4 min. No auto-login on new work.

## Contract (locked before fan-out — both sides build against this)

**Directory** unchanged: `KBIZ_QR_DIR`, default `/app/data/qr-login` in both
containers (host `/home/deploy/payroll-production/data/qr-login`).

**Files** (all bot-side writes atomic via `fs-atomic.ts`):

- `state.json` + `current.png` — the QR handoff publication, UNCHANGED
  (`status: waiting|ok|expired|error`, `reason`, `attempt`, `capturedAt`,
  `expiresAt`, `updatedAt`, `message`).
- `session.json` — NEW, written by the bot's session keeper on every check:
  ```json
  {
    "alive": true,
    "since": "ISO — when this session was first seen alive, or null",
    "checkedAt": "ISO — last keepalive check",
    "endedAt": "ISO — when the last session was found dead, or null",
    "lastLifetimeMs": 18600000,
    "pending": 2,
    "note": "short masked text, e.g. 'keepalive ok' / 'bounced to login' / 'browser restarted'"
  }
  ```
  `pending` = approved queue items waiting (0 when none). `lastLifetimeMs`
  = `endedAt - since` of the most recent ended session (null until one ends)
  — the instrument that tells us the bank's session cap.
- `login.request` — NEW, written by payroll-form when the operator presses
  the button: `{ "requestedAt": "ISO", "by": "email from cf-access-authenticated-user-email, or 'unknown'" }`.
  The bot CLAIMS it by renaming to `login.request.claimed` (overwriting any
  previous claimed file) BEFORE touching the bank, exactly like
  `payroll-bank-backfill.ts`. payroll-form never deletes it.

**Page states** (payroll-form derives, priority order):
1. `state.status === "waiting"` (and not stale) → the QR, as today.
2. `login.request` present → "กำลังเตรียม QR…" (requested at …), no button.
3. `session.alive` → "เข้าสู่ระบบ K BIZ อยู่ ตั้งแต่ <since>" + pending count,
   no button (nothing to do).
4. otherwise → the button **"เข้าสู่ระบบ K BIZ"**, with the last handoff
   result (`expired` / `error` / `ok` message) and `pending` shown if any.
`idle` (no files) renders as 4 with "ยังไม่มีข้อมูล".

**Routes** (payroll-form; all `private, no-store`; existing three unchanged):
- `POST /kbiz/login-qr/request` → writes `login.request` (atomic). `202`
  `{"accepted":true}`; if `login.request` already exists → `202`
  `{"accepted":true,"already":true}`; if `state.json` is `waiting` and not
  stale → `409` `{"error":"qr-already-showing"}`. Body ignored. The button
  calls it with `fetch(..., {method:"POST", credentials:"same-origin"})`, then
  the existing 5 s poll shows progress. Auth: the whole-hostname Cloudflare
  Access edge gate (same as the page). A cross-site POST can at worst make
  the bot show a login QR that only the owner's app can complete — accepted.

**Slack** (bot webhook, text only; `<link>` = `KBIZ_QR_PAGE_URL`):
- session ended (once per death): `:warning: kbiz-bot: เซสชัน K BIZ หมดอายุแล้ว (อยู่ได้ <H ชม. M นาที>) — เมื่อมีจอที่สองแล้ว เปิด <link> แล้วกด "เข้าสู่ระบบ K BIZ"`
- work waiting while dead (when the pending count changes, and at most once per hour otherwise): `:hourglass: kbiz-bot: มี <n> งานรอ K BIZ — เปิด <link> แล้วกด "เข้าสู่ระบบ K BIZ"`
- morning reminder (08:30 Asia/Bangkok, once per day, only while dead): `:sunrise: kbiz-bot: เซสชัน K BIZ ยังไม่ได้เข้าสู่ระบบ — เปิด <link> แล้วกด "เข้าสู่ระบบ K BIZ"`
- login started by the button: the existing `:lock:` QR line (attempt #1) is
  KEPT (it confirms the request landed); `:white_check_mark:` on success and
  `:hourglass: … ไม่มีการสแกนใน 6.5 นาที` on timeout are kept, but the timeout
  line ends with `กดปุ่มใหม่เมื่อพร้อม` instead of "จะขอใหม่ใน 10 นาที".
- request while already alive: `:white_check_mark: kbiz-bot: เซสชัน K BIZ ยังใช้งานได้ ไม่ต้องสแกน`

**Bot loop** (`process-queue.ts --watch`), one process, single-threaded:
- Startup: the session keeper opens the persistent Chromium context ONCE
  and keeps it for the process lifetime; first check → `session.json`.
- Tick every `KBIZ_TICK_MS` (default 5 000):
  1. **Trigger**: if `login.request` exists and no handoff is in progress →
     claim it, then `gotoAuthenticated(page, DASHBOARD, { onQr: "handoff", reason: "login requested by <by>" })`.
     Already alive → Slack the "ยังใช้งานได้" line; QR path → existing handoff
     (publishes QR, waits ≤ 6.5 min, confirms dashboard). On success the
     keeper marks alive (`since` = now); on timeout it stays dead.
  2. **Keepalive**: if alive and `now - checkedAt >= KBIZ_KEEPALIVE_MS`
     (default 240 000) → `gotoAuthenticated(page, DASHBOARD)` with the
     default `refuse` policy; `QrLoginRequiredError` / bounce / dead text →
     mark dead (`endedAt`, `lastLifetimeMs`), Slack the "หมดอายุ" line ONCE.
     A crashed/closed browser → reopen the context, then check (cookies live
     in the profile volume, so a quick restart usually keeps the session).
  3. **Queue** every `QUEUE_POLL_MS` (30 000): `publishPayeeHandles`; list
     approved; if none → nothing. If alive → `processBatch(page)` using the
     keeper's page (the item loop, gate, claim, arm lock: UNCHANGED; the
     warm-up becomes a cheap refuse-policy `ensureLoggedIn` — if it throws,
     mark dead and skip the batch untouched). If dead → the "งานรอ" nudge
     (rate-limited as above), items untouched. Then the settlement check,
     only when alive, on the keeper's page.
  4. **Morning reminder** at `KBIZ_LOGIN_REMINDER_HHMM` (default `08:30`,
     Asia/Bangkok = UTC+7, no DST) once per calendar day while dead.
- The old `lastLoginFailAt` cooldown + `shouldAttemptLogin` are REMOVED (no
  automatic login exists any more). `scripts/kbiz-login-handoff.sh` is
  DELETED (the button replaces it). `src/login.ts` stays for dev, with a
  warning that it must never run against the prod profile while the watcher
  is up.
- All keeper decisions are a PURE module (`session-keeper-core.ts`, no
  playwright/fs, thunks + virtual clock) — which action(s) a tick takes,
  nudge/reminder rate-limiting, lifetime arithmetic, Bangkok day boundaries.
  The playwright half (`session-keeper.ts`) only opens/closes the context
  and runs the check.

**Env** (all optional): `KBIZ_TICK_MS` (5000), `KBIZ_KEEPALIVE_MS` (240000),
`KBIZ_LOGIN_REMINDER_HHMM` (08:30), plus the existing `KBIZ_QR_DIR`,
`KBIZ_QR_PAGE_URL`, `QUEUE_POLL_MS`. No new secrets.

## Tests

kbiz-bot (root `bun test` runs it without playwright): keeper core with a
virtual clock — first check alive/dead, ping due only after the interval,
death reported once with the right lifetime, nudge on count change and at
most hourly, reminder once per Bangkok day only while dead, no action while a
handoff is in progress, request claimed before any bank access; files —
request read/claim (rename, overwrite of a stale claimed file), session.json
write. Existing money-path tests untouched and green.
payroll-form: POST route (202 new, 202 already, 409 while a QR is showing,
writes the contract JSON with the CF email header when present), the four
page states + idle, existing route tests green.

## Deploy / verify

PR → CI → merge → `deploy.yml` rebuilds both images. Live: `session.json`
appears within a minute of the bot starting; the page shows either "alive"
or the button; pressing the button on a second screen yields a QR within ~10 s;
after the scan the page says logged in. The first "หมดอายุ" Slack line tells
us the bank's session cap.
