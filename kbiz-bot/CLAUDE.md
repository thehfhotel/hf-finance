# CLAUDE.md — kbiz-bot

The ONLY thing in the estate that logs into the bank. Headless Playwright
driver for KBIZ (KBank Business Online), running on evergreen as a
`process-queue.ts --watch` container in the payroll stack.

## Hard rules

- **The phone tap is the gate.** KBIZ's "Next" on fundtranfer-other IS the
  commit — clicking it sends the approval push to the K BIZ phone app. The bot
  arms; a human approves. Nothing here may bypass, retry-past, or simulate
  that approval, ever.
- **One warm session, and since CR-2026-09-17 a RESIDENT one.** The watch
  container opens the persistent Chromium profile (`browser-data/`) ONCE at
  startup and holds it for the process lifetime: the queue step, the 4-minute
  keepalive ping and the operator's QR login all drive the SAME page
  (`lib/session-keeper.ts` owns it; `openSession`/`closeSession` in
  `lib/session.ts` are the primitives, and `withSession` is now just those two
  around a callback — unchanged for every one-shot script). KBIZ punishes
  concurrent logins — never run two scripts at once, never log in from
  elsewhere while the bot works, and NEVER run `npm run login` against the prod
  profile while the watcher is up (it would fight for the profile lock and kill
  the resident session). Login used to auto-recover with user/pass alone; since
  June 2026 it does NOT (see the QR handoff rule below) — a re-login needs a
  human with the K BIZ phone app.
- **The bot never starts a login on its own (CR-2026-09-17).** The K BIZ app
  cannot scan a QR from a saved picture, so a scan always needs a SECOND screen
  — an unsolicited QR is usually one nobody can use. So the bot keeps its
  session alive, SAYS what it knows, and waits: `session.json` (written by the
  keeper on every check and whenever the pending count changes) drives the
  operator page, and Slack carries four lines — the session ended (once per
  death, with the lifetime `endedAt - since`, our only instrument for the bank's
  session cap), work is waiting while dead (on a count change, else hourly), the
  08:30 Asia/Bangkok reminder (once per day, in the hour after 08:30, only while
  dead — the day is SEEDED at startup, since the state is memory-only and a
  redeploy would otherwise re-post it) and "ยังใช้งานได้" when the button is
  pressed on a session that was fine.
  **Only the bank's own signals are a death**: `QrLoginRequiredError` and the
  "still bouncing after a re-login" throw (`isSessionDeathError`). A bank
  outage, a network blip or a context that vanished mid-navigation is
  UNCLASSIFIED — counted (by the keepalive AND by the batch warm-up, so with
  work waiting the strikes come at the 30 s queue cadence), and a death only
  after three in a row. A death declared on a blip is expensive three times over: a
  "หมดอายุแล้ว" nobody can act on, the blip written into `lastLifetimeMs`, and a
  bot that then never re-checks (the keepalive only runs while alive) until a
  human presses the button. Every note published to `session.json` goes through
  `maskedNote` — raw Playwright errors carry `loginQR.do?cmd=<token>`.
  A login begins ONLY when payroll-form writes `login.request` and the bot
  CLAIMS it by renaming it to `login.request.claimed` BEFORE touching the bank
  — the same request/claim shape `payroll-bank-backfill.ts` uses, so a crash,
  an outage or an unscanned QR can never turn one press of the button into a
  retry loop. All of that is decided in `lib/session-keeper-core.ts` (pure: tick
  order, rate limits, lifetime arithmetic, Bangkok day boundaries, every Slack
  line), never in the driver. Do NOT add a SIGTERM/SIGINT handler: playwright
  already closes the browser on `docker stop` and a second handler races it for
  the same context.
- **QR handoff — only the operator's button and `src/login.ts` request a scan;
  the batch warm-up, the settlement check and every flow refuse.**
  `gotoAuthenticated`/`ensureLoggedIn` take `{ onQr: "handoff" | "refuse" }` and
  default to `"refuse"`, which throws
  `QrLoginRequiredError` the instant the bank lands on `loginQR.do` instead of
  waiting 60 s and crashing an item. `"handoff"` publishes the QR to
  `KBIZ_QR_DIR` + Slack and waits 6.5 min for a human. Three files, one job:
  `lib/qr-login-core.ts` (pure state machine; its one import is
  `approval-wait.ts`), `lib/qr-login-files.ts` (fs-only — `QR_DIR`,
  `current.png`/`state.json`, the stale-publication sweep; its `dir` params are
  the test seam) and `lib/qr-login.ts` (the Page-bound driver, the only one
  that pulls playwright; `lib/session-keeper.ts` runs it on the resident page).
  The 12×500 ms post-navigation session probe both `gotoAuthenticated` and the
  handoff's `confirmDashboard` run lives once, in
  `lib/session-probe.ts`; Slack has one voice, `lib/slack.ts`. The handoff runs
  in exactly two places: the keeper's `login()` (the claimed button press) and
  the operator's `npm run login` — each passes its own `reason`, which
  `onQr: "handoff"` requires. `processBatch`'s warm-up is now a CHEAP
  refuse-policy `ensureLoggedIn(page)` before the item loop, before any claim or
  arm-lock write: on failure it tells the keeper the session is dead and returns
  with every item still `approved`, and it Slacks nothing itself (the keeper
  already says "หมดอายุ" once per death and nudges while work waits). The old
  `shouldAttemptLogin` 10-minute cooldown is GONE along with the automatic ask
  it rate-limited; `test/qr-login-warmup.test.ts` now pins that absence. The
  stale-publication sweep runs at handoff ENTRY, not at process start (payroll-form
  downgrades a stale `waiting` at read time). Never screenshot the QR — decode
  `img.qrcode`'s `src` data URI — and never treat the bank's own redirect as
  proof: confirm the dashboard.
- **Ambiguity is never auto-resolved.** Outcomes are four-way: success /
  confirmed-failed (retryable — the bank explicitly rejected it, nothing
  moved) / push-expired (retryable — the bank's own expiry modal, the ~6 min
  phone-approval window closed with no tap; added 2026-08-19 because this used
  to fall through into `unconfirmed` with misleading English prose for a
  transaction the bank had already proven moved ฿0) / unconfirmed
  (needs-review; a human checks the K BIZ app before anything pays again). A
  timeout or generic error page is NEVER "failed, safe to retry".
- **Full account numbers never leave this container.** The payee book
  (`transfer-other.config.json`, gitignored, mounted read-only from
  `/home/deploy/kbiz-bot/` in prod) holds them; everything published to the
  shared queue (manifests, errors, Slack) is masked to last-4.
- **One live approval push in the estate, ever.** KBIZ's approval push lives
  SERVER-SIDE at the bank, not in our browser session — a crash or session
  death after the Next click leaves it tappable for minutes, and a naive
  batch loop would happily arm the next one on top of it (two incidents,
  2026-08-12 + 2026-08-13; see the ADR's Amendment 6). `arm-gate.ts` (pure
  decision) + `arm-lock.ts` (durable state) enforce the invariant across
  **every** arming path — `transfer-other` (arms on Next), `transfer-payroll`
  (on Confirm) and `add-payroll` (on Next; KBIZ answers with the "notification
  has been sent to the K BIZ application" screen and the flow waits 5 min for
  the tap). Only `list-favorites` / `list-registered` are push-free. Each path
  both READS the lock and WRITES it: `process-queue.ts` defers (never skips or
  forces) a batch item that would arm a second push, and `transfer-other.ts
  --confirm` / `transfer-payroll.ts` refuse outright under a live lock and take
  their own before arming — a hand-run script that only read the lock would
  leave the watch loop free to arm on top of it, which is how the invariant was
  false while the docs claimed it.
  **The state file** is `<KBIZ_STATE_DIR>/kbiz-arm-lock.json` (default `../data`,
  i.e. `/app/data` in the container) — written conservatively BEFORE the
  arming click (covering the form-fill window a crash could land in), never
  deleted (`state: "released"` is how a lock ends, so there is no ENOENT
  race), and released only when the flow proves the push is no longer live —
  never from a crash handler, since a crash cannot prove that. **The harness
  split** that makes this provable without a browser: `approval-wait.ts`,
  `arm-gate.ts` and `finalize-transfer.ts` are pure — zero playwright/fs
  imports, a plain number for `now`, the page reached only through thunks — so
  `bun test` at the repo root, BEFORE kbiz-bot's node_modules even exist,
  proves the invariant (and R5: a slip-capture failure never downgrades a
  bank-confirmed success); `arm-lock.ts` and `qr-login-files.ts` are fs-only (both write through
  `fs-atomic.ts`'s `writeAtomic`; `qr-login-files.ts` also owns `session.json`
  and the `login.request` read/claim), and `session-keeper-core.ts` is pure like
  `arm-gate.ts`; only `transfer-other-flow.ts`, `process-queue.ts`,
  `session*.ts`, `session-keeper.ts` and `qr-login.ts` touch playwright. Never blur
  that split — a runtime playwright import in a pure or test file passes
  locally and breaks root CI.

## The contract

Types come from the monorepo's shared package:
`../reimbursement/packages/shared/src/index.ts` (`@reimbursement/shared`). A
contract change rebuilds this image (CI paths filter includes
`reimbursement/packages/shared/**`).

**That specifier resolves two different ways, and both are load-bearing:**

- **Dev, CI, `tsc`, `bun test`** — the `paths` entry in `kbiz-bot/tsconfig.json`.
- **The container** — a node_modules symlink the Dockerfile creates
  (`node_modules/@reimbursement/shared` → `/app/reimbursement/packages/shared`)
  plus that package's own `exports`/`main`. The image has **no tsconfig.json**:
  the repo-root `.dockerignore` excludes `kbiz-bot/*.json` and re-includes only
  `package.json`, so the file is not even in the build context. Deleting the
  symlink as "redundant" crashloops the bot at startup with
  `ERR_MODULE_NOT_FOUND` while CI stays green. So does repointing the shared
  package's `exports` at a `dist/` build output.

`kbiz-bot/test/shared-resolution.test.ts` pins both mechanisms to one file —
if you change the Dockerfile, the tsconfig mapping or the shared package's
entry fields, that test is the thing that tells you the other end moved.

**`tsx` reads its tsconfig from `process.cwd()`, not from the imported file's
directory** — so the bot must always be launched from `kbiz-bot/`.
`node --import tsx kbiz-bot/src/process-queue.ts` from the repo root fails; the
npm scripts and the Dockerfile's `WORKDIR /app/kbiz-bot` both get this right.

**CI DOES run `tsc`** (corrected 2026-08-19 — this paragraph used to claim the
opposite, which was stale even before this fix landed). `deploy.yml`'s `test`
job runs `bun test` at the repo root AND, as a separate step, `bun run
typecheck` inside `kbiz-bot/` (`deploy.yml:138-140`) — so "the contract is a
compile error now" is true in CI itself, on every push and every PR, not only
for whoever happens to run `npm run typecheck` locally. `test/shared-contract
.test.ts` is a second, independent drift check that reads the shared source as
text rather than importing it — it catches a contract change even for someone
running only `bun test` with no `tsc` at all, which is exactly the situation
root `bun test` is in before `kbiz-bot/node_modules` exists.

## Facts pinned against the live site (probed + live-verified 2026-08-12)

- The KBIZ session runs THAI (`login.jsp?lang=th`) so scraped account names
  are Thai. Bank matching must go through `aliasesForBank()` (EN↔TH) — never
  a bare substring.
- **Thai "Next" is "ต่อไป", not "ถัดไป"** (verified live on fundtranfer-other
  2026-08-12), and that verified locator also filters out `.disabled-button` —
  KBIZ renders Next visible-but-disabled while a form is incomplete, and
  Playwright's enabled-check does not apply to an `<a>`.
  **payroll/upload-transfer, probed read-only 2026-09-04 after the incident:**
  the file input is `input.custom-file-upload-hidden[name=uploadfile]`; Next is
  `a.btn.fixed-width.btn-gradient` "ต่อไป" and exists ONLY after a file is
  selected (no "ถัดไป"/"Next" anywhere); dialogs are `#popup-*` with
  `.popup-modal-close` buttons, and a hidden `a.btn-gradient` "ยืนยัน" lives in
  one of them. The payroll flows had guessed "ถัดไป", so the first Next after a
  payroll upload timed out and crashed the queue item on 2026-09-04. Both
  payroll flows now match the verified labels only (`NEXT_SELECTOR`, pinned by
  `test/payroll-labels.test.ts`) and carry the disabled filter; transfer-payroll
  additionally matches Confirm bilingually (`CONFIRM_SELECTOR` — a SUBSTRING
  match, so it is re-checked against the refusal popups before the arming
  click, since KBIZ's own refusal dialogs carry a "ยืนยัน" anchor), while
  add-payroll has no Confirm step and detects the review screen by text. The
  review screen after Next and its Confirm ("ยืนยัน") were verified by the live
  payroll run of 2026-09-04 (Next matched at once, Confirm armed the push, the
  tap landed, item done). The account-payroll page is still unprobed under
  Thai — its next live add-payroll run is the verification.
- **Login needs a QR scan, every time (live-verified 2026-09-17).** After
  `#loginBtn` the bank redirects to `/authen/loginQR.do?cmd=…` — an `/authen/`
  URL, so `isUnauthenticatedUrl` matches it and the old `waitForURL` could only
  ever time out there. The page renders `img.qrcode`, a 150×150
  `data:image/png;base64` data URI, under "กรุณาทำรายการภายใน 05:55 นาที", and
  the bank redirects ITSELF to `/menu/account/account-summary` once the app
  confirms. The QR rotates; each fresh one is a new `attempt`. There is no
  unattended path — bank policy — so the only correct responses are "refuse
  now" or "ask a human".
- **K BIZ payroll deadline (page copy, 2026-09-04):** a batch must be approved
  by 17:00 at least one day before the pay date, or KBIZ refuses it.
- **`page.evaluate` + tsx:** esbuild's keepNames wraps any NAMED inner function
  (`const f = () => …`) inside an evaluate callback with `__name(...)`, which
  does not exist in the browser (`ReferenceError: __name is not defined`). Keep
  evaluate callbacks free of inner named functions, or pass the page-side code
  as a string.
- A payroll Next that never appears now writes a full-page PNG next to the
  slips (`KBIZ_SLIPS_DIR`, `src/lib/next-timeout.ts`). That shot is unmasked
  page content, and the dir is re-pointable at the shared cross-stack mount
  (the `./data/slips` nested bind drafted, commented out, in `EVERGREEN.md`) — if you
  ever flip that bind on, give these screenshots a container-local dir instead.
- fundtranfer-other needs a 1600px viewport (1366 is a breakpoint edge where
  rows render non-visible).
- The saved-payee picker opens from `a.input-search-acc`; rows are `div.lists`
  with `<p>label</p><p>value</p>` pairs (labels: ชื่อย่อบัญชี / ชื่อบัญชี /
  ธนาคาร / เลขบัญชี), every row rendered twice (dedupe), numeric `a.pointer`
  pagination. Clicking a row's account link SELECTS the payee — a read-only
  scrape must never click it.
- Success is keyed on the slip page's tokens ("โอนเงินสำเร็จ", "Transaction
  ID", TRBS/TRTS refs) — the waiting screen also says "successfully", don't
  match bare "success". Failure-before-success ordering is deliberate and
  test-pinned.
- The memo field rejects special characters (sanitize to Thai/alnum/space).
  The rule is the contract's `sanitizeKbizMemo`, not a bot-local copy — the
  old `sanitizeMemo` in `transfer-other-flow.ts` is gone and is deliberately
  not re-exported (that module pulls playwright; root CI runs `bun test`
  without it). **One deliberate behavior delta** vs. the deleted local copy:
  shared appends `.trimEnd()` after the 100-char cap, so an input that
  sanitizes to >100 chars and gets cut mid-space now yields 99 chars, not 100
  with a trailing space. Unreachable on the money path (reimbursement builds
  every intent memo with `buildKbizMemo`, already capped + trimmed, and
  re-sanitizing is idempotent); reachable only via
  `npm run transfer-other -- --memo <101+ chars>`. If you are diffing prod memo
  behavior against git history, that is the difference.

## Testing

`bun test` must pass from BOTH `kbiz-bot/` and the repo root (CI runs the root
context without kbiz-bot's node_modules — no test import may reach playwright;
keep the pure-core/driver file split). `bunx tsc --noEmit -p tsconfig.json`
strict. No live-KBIZ test runs without the operator watching.

## Payroll completeness verification (2026-09-15)

- `done` payroll is submitted, never automatically paid. The post-phone-approval
  `getTransactionSuccessPayroll` response supplies `result.bankReferenceNo` for
  later matching. Legacy retries may use bank `attachFileName` ONLY when it
  exactly equals the source's generated `${id}.xlsx`, with unique local workbook
  ownership and bank batch. Missing filenames retain unique exact-data fallback;
  supplied mismatching filenames never do. Only the history verifier writes
  `payrollSettlement` proof.
- `PAYROLL_BANK_VERIFY_SINCE` enables verification of recent submitted runs; it is
  independent of the ledger's new-submission-only cutoff.
- Live read-only verified: `/menu/account/account/history`, dropdown `#tranType`
  value `PYRL`, search `#btnSearch`. History inquiry response has decimal-string
  `amount`, numeric `totalTransactions`, `totalSuccess`, `totalFail`; beneficiary
  detail has numeric `amount`, full `beneficiaryNo`, `reqRefNo`, `transStatus`.
  Batch and each recipient must say `Success`, batch approval `AP`, all counts
  match, and `executeDate === transactionStatusDate` after parsing Bangkok-local
  SQL timestamps. Never use create/approval/scheduled date as actual paid date.
- Read-only history checks share the existing serialized queue loop and browser
  profile — since CR-2026-09-17 literally the resident keeper's page, passed in
  as `checkPayrollBankSettlements(dir, now, { page })`. Omit `page` and it falls
  back to its own `withSession`, which is what the one-shot CLIs use. Never
  start a competing login, arm a push, or invoke transfer/approval APIs from the
  history reader. New pure core/files modules contain no browser imports so root
  CI stays Playwright-free.
- `payroll-bank-core.ts` also imports the pure root `src/payroll-settlement.ts`;
  the bot Dockerfile copies that file to `/app/src`. Keep the deploy workflow's
  bot path trigger for this shared helper.
