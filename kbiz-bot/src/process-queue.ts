import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Page } from "playwright";
import { gotoAuthenticated, ensureLoggedIn } from "./lib/session";
import { runAddPayrollFlow } from "./flows/add-payroll-flow";
import { runTransferPayrollFlow } from "./flows/transfer-payroll-flow";
import { runTransferOtherFlow } from "./flows/transfer-other-flow";
import { scrapeRegisteredAccounts } from "./lib/scrape-registered";
import { FAVORITES_FILE, scrapeFavorites } from "./lib/scrape-favorites";
import { loadTransferConfig } from "./lib/transfer-config";
import { HANDLES_FILE, publishPayeeHandles } from "./lib/payee-handles";
import { checkPayrollBankSettlements } from "./lib/payroll-bank-check";
import { htmlToPdf } from "./lib/html-to-pdf";
import { PUSH_LIFETIME_MS } from "./lib/approval-wait";
import {
  armedLock,
  conservativeLock,
  decideArm,
  deferredErrorText,
  deferredMessage,
  livePushWarning,
  parseArmLock,
  releasedLock,
  TAP_COOLDOWN_MS,
  type ArmLock,
  type PrevMoneyItem,
} from "./lib/arm-gate";
import { readArmLockRaw, writeArmLock } from "./lib/arm-lock";
import { notifySlack } from "./lib/slack";
import {
  DEFAULT_QR_PAGE_URL,
  isSessionDeathError,
  maskedNote,
  maskQrMessage,
  qrTimeoutMessage,
  sessionAliveMessage,
} from "./lib/qr-login-core";
import { claimLoginRequest, readLoginRequest, writeSessionFile } from "./lib/qr-login-files";
import { createSessionKeeper, type KeeperCheckResult } from "./lib/session-keeper";
import {
  applyCheckResult,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_QUEUE_POLL_MS,
  DEFAULT_REMINDER_HHMM,
  DEFAULT_TICK_MS,
  decideTick,
  initialKeeperState,
  isAlive,
  keeperSlackLine,
  markQueueRan,
  markReopened,
  parseReminderHhmm,
  seedReminderDay,
  sessionFileFrom,
  setPending,
  withNote,
  type KeeperAction,
  type KeeperConfig,
  type KeeperState,
} from "./lib/session-keeper-core";
import {
  decideDuplicateConfirm,
  describeDestination,
  destinationSignature,
  duplicatePopupMessage,
  mapFlowOutcomeToPatch,
  parseTransferOtherRequest,
  pauseBeforeArmMessage,
  requestOrderCompare,
  resolveQueuePayee,
  resolveSharedPath,
  slipFileBasename,
  tapNeededMessage,
  transferOtherPositions,
  type DuplicateReason,
  type PriorAttempt,
  type TransferOtherQueuePatch,
  type TransferOtherQueueRequest,
} from "./lib/transfer-other-queue";

// Same page list-payroll-accounts.ts scrapes; a "list-registered" queue item
// is the button-triggered version of that manual script.
const LIST_URL = "https://kbiz.kasikornbank.com/menu/setting/account-list/account-payroll";

// KBIZ_QUEUE_DIR / KBIZ_SHARED_DIR decouple this from the `../data` layout so
// the container can be pointed at a shared cross-repo dir (e.g.
// `/srv/kbiz-queue`) instead. Unset preserves today's behavior exactly.
const QUEUE_DIR = process.env.KBIZ_QUEUE_DIR ? resolve(process.env.KBIZ_QUEUE_DIR) : resolve("..", "data", "queue");
// Root that a transfer-other intent's relative paths (voucherFile) resolve
// against. Defaults to `../data`, matching QUEUE_DIR's and capture-slip's
// default `../data/{queue,slips}` so the three line up unless overridden.
const SHARED_DIR = process.env.KBIZ_SHARED_DIR ? resolve(process.env.KBIZ_SHARED_DIR) : resolve("..", "data");

/** The add-payroll / transfer-payroll / list-registered queue-item shape. */
type PayrollQueueRequest = {
  id: string;
  type: "add-payroll" | "transfer-payroll" | "list-registered";
  status: string;
  xlsxPath: string;
  summary: unknown;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  result?: { success: boolean; finalUrl?: string; error?: string; bankReferenceNo?: string };
};

/**
 * A read-only sync item: no workbook, no payee, no money. reimbursement
 * queues one ("sync_<uuidhex>") when an approver refreshes the destination
 * picker, and the bot answers by republishing queue/kbiz-favorites.json.
 */
type SyncQueueRequest = {
  id: string;
  app: "reimbursement";
  type: "list-favorites";
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  result?: { success: boolean; count?: number; error?: string };
};

type QueueRequest = PayrollQueueRequest | TransferOtherQueueRequest | SyncQueueRequest;

async function listApproved(): Promise<QueueRequest[]> {
  const files = await readdir(QUEUE_DIR).catch(() => [] as string[]);
  const out: QueueRequest[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    // The handles + favorites manifests live alongside the queue items (only
    // shared path needing no new mount) — they are metadata, never requests.
    if (f === HANDLES_FILE || f === FAVORITES_FILE) continue;
    try {
      const buf = await readFile(join(QUEUE_DIR, f), "utf8");
      const parsed = JSON.parse(buf) as { type?: unknown };
      const req: QueueRequest =
        parsed.type === "transfer-other"
          ? parseTransferOtherRequest(parsed)
          : (parsed as PayrollQueueRequest | SyncQueueRequest);
      if (req.status === "approved") out.push(req);
    } catch (e) {
      console.warn(`⚠ skipping malformed queue file ${f}: ${(e as Error).message}`);
    }
  }
  // Request order, not id order — see requestOrderCompare's incident note.
  out.sort(requestOrderCompare);
  return out;
}

async function patchRequest(id: string, patch: Record<string, unknown>): Promise<void> {
  const path = join(QUEUE_DIR, `${id}.json`);
  const buf = await readFile(path, "utf8");
  const req = JSON.parse(buf);
  Object.assign(req, patch, { updatedAt: new Date().toISOString() });
  await writeFile(path, JSON.stringify(req, null, 2), "utf8");
}

async function runListRegistered(page: Page): Promise<{ success: boolean; finalUrl?: string; error?: string }> {
  await gotoAuthenticated(page, LIST_URL);
  const reg = await scrapeRegisteredAccounts(page); // writes data/kbiz-registered.json
  console.log(`✓ ${reg.count} registered accounts written to data/kbiz-registered.json`);
  return { success: true, finalUrl: LIST_URL };
}

/** Refresh the destination picker's saved-account list (read-only, no money). */
async function runListFavorites(page: Page): Promise<number> {
  const { favorites } = await scrapeFavorites(page, QUEUE_DIR); // writes queue/kbiz-favorites.json
  console.log(`✓ ${favorites.length} saved account(s) written to ${FAVORITES_FILE}`);
  return favorites.length;
}

/**
 * Drive a single `transfer-other` intent: resolve the destination (a picked
 * favorite or typed account, else the payee handle the bot's own config
 * resolves — see decision 4 in docs/adr/0001-kbiz-transfer-automation.md),
 * best-effort attach the rendered voucher, run the flow with `confirm: true`,
 * and map the outcome to the queue patch the watch loop writes back.
 *
 * Every early-return here happens BEFORE the phone push is ever armed, so it
 * is always safe to file as "nothing moved" (mapFlowOutcomeToPatch's
 * no-outcome branch). Only the flow itself, once Next is clicked, can produce
 * a genuine `unconfirmed`.
 */
/**
 * The queue patch PLUS the two facts only the flow knows and the patch cannot
 * express: whether a push was ever armed (DEFECT C — a mis-typed handle and a
 * bank-confirmed rejection file identically), and whether it might still be
 * live. The batch gate and the operator warning both read these; neither is
 * part of the cross-repo queue-file contract, so neither is written to disk.
 */
type QueueItemOutcome = TransferOtherQueuePatch & { armedAt?: number; pushMayBeLive?: boolean };

/**
 * Scan the hot queue AND `QUEUE_DIR/archive` for other `transfer-other`
 * attempts already on record — against THIS bundle, or against the SAME
 * destination + amount under any OTHER bundle. Feeds decideDuplicateConfirm's
 * fail-closed judgement on KBIZ's exact-duplicate popup (GAP 2,
 * kbiz-fix-spec.md §2.2): the bank's own duplicate check keys on a
 * transaction that ACTUALLY WENT THROUGH, so a popup plus a prior attempt
 * that could plausibly be the SAME money means the prior one paid —
 * confirming here would be the double-pay.
 *
 * ok: false on a readdir failure of QUEUE_DIR itself — that IS the reason
 * listApproved exists, so a scan we could not even start must never license a
 * confirm. `QUEUE_DIR/archive` not existing yet is fine (a fresh estate has
 * archived nothing) — that is a complete, empty scan of it, not a failure. A
 * malformed sibling file is skipped, exactly like listApproved's own
 * `catch (e)` — one bad file must not blind the scan to every other one.
 *
 * MONEY REVIEW FINDING 1 (2026-08-19): this used to keep only TERMINAL
 * attempts (`done`/`failed`/`needs-review`), which drops the two statuses
 * that most mean "may have paid" — `running` (the flow is mid-tap right now,
 * e.g. a killed container never wrote a terminal status) and `approved`
 * (queued but not yet claimed). A sibling stuck at `running` after a crash is
 * exactly the "may have paid" case decideDuplicateConfirm exists to catch —
 * dropping it here let the SAME bundle's retry auto-confirm KBIZ's popup with
 * `reason:"no-prior-attempt"`, on a popup the bank raised BECAUSE the earlier
 * attempt actually moved the money. There is no status filter any more: ANY
 * sibling intent file for this bundle is a blocking prior attempt, full stop.
 *
 * Never logs a full account number: the hot queue's `custom` destinations
 * carry one (the archive's copy is already redacted by reimbursement's
 * `archiveQueueFile`, but the LIVE queue dir is not), so only ids are logged.
 */
async function readPriorAttempts(bundleId: string, selfId: string): Promise<{ ok: boolean; attempts: PriorAttempt[] }> {
  const attempts: PriorAttempt[] = [];
  const dirs = [QUEUE_DIR, join(QUEUE_DIR, "archive")];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (e) {
      if (dir === QUEUE_DIR) {
        console.warn(`⚠ could not scan ${dir} for prior attempts on bundle ${bundleId}: ${(e as Error).message}`);
        return { ok: false, attempts: [] };
      }
      continue; // archive/ missing = nothing archived yet, not a scan failure
    }
    for (const f of files) {
      if (!f.endsWith(".json") || f === HANDLES_FILE || f === FAVORITES_FILE) continue;
      try {
        const buf = await readFile(join(dir, f), "utf8");
        const parsed = JSON.parse(buf) as Record<string, unknown>;
        if (parsed.app !== "reimbursement" || parsed.type !== "transfer-other" || parsed.id === selfId) {
          continue;
        }
        // MONEY REVIEW FINDING 1: no status filter (see the function
        // comment) — every sibling, regardless of `status`, is kept. This
        // scan is intentionally NOT pre-filtered to `bundleId` any more
        // either (MONEY REVIEW FINDING 2, below): decideDuplicateConfirm now
        // ALSO checks same-destination-+-same-amount across DIFFERENT
        // bundles, because KBIZ's own duplicate predicate is payee+amount,
        // not bundle — a resubmitted receipt after an `unconfirmed` original
        // lands as a brand-new bundle and would otherwise defeat this guard
        // entirely.
        const status = typeof parsed.status === "string" ? parsed.status : undefined;
        const result = parsed.result as { outcome?: string } | undefined;
        const parsedBundleId = typeof parsed.bundleId === "string" ? parsed.bundleId : undefined;
        // MONEY REVIEW FINDING 6: feeds SAME_MONEY_WINDOW_MS in
        // decideDuplicateConfirm. An unparseable/absent createdAt yields
        // `undefined`, which that function treats as "still inside the
        // window" — fail-closed, never an accidental bypass.
        const createdAtMs = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
        attempts.push({
          id: typeof parsed.id === "string" ? parsed.id : f,
          bundleId: parsedBundleId,
          status,
          outcome: result?.outcome,
          destinationKey: destinationSignature(parsed),
          amount: typeof parsed.amount === "number" && Number.isFinite(parsed.amount) ? parsed.amount : undefined,
          createdAt: Number.isFinite(createdAtMs) ? createdAtMs : undefined,
        });
      } catch (e) {
        console.warn(`⚠ skipping malformed sibling ${f} while scanning for duplicates on bundle ${bundleId}: ${(e as Error).message}`);
      }
    }
  }
  return { ok: true, attempts };
}

async function runTransferOtherQueueItem(
  page: Page,
  req: TransferOtherQueueRequest,
  onArmed?: (armedAt: number) => void | Promise<void>,
): Promise<QueueItemOutcome> {
  let config;
  try {
    config = loadTransferConfig();
  } catch (e) {
    return mapFlowOutcomeToPatch({ success: false, error: `config: ${(e as Error).message}` });
  }

  let payee;
  try {
    payee = resolveQueuePayee(req, config);
  } catch (e) {
    // Unknown handle or malformed destination → fail with a clear error.
    // Never guess a payee.
    return mapFlowOutcomeToPatch({ success: false, error: (e as Error).message });
  }

  if (req.amount > config.maxTransfer) {
    return mapFlowOutcomeToPatch({
      success: false,
      error: `Amount ฿${req.amount.toFixed(2)} exceeds config ceiling ฿${config.maxTransfer.toLocaleString()} — refusing.`,
    });
  }

  let attachmentPath: string | undefined;
  if (req.voucherFile) {
    try {
      const htmlPath = resolveSharedPath(SHARED_DIR, req.voucherFile);
      const html = await readFile(htmlPath, "utf8");
      const pdfPath = resolveSharedPath(SHARED_DIR, `vouchers/${req.id}.pdf`);
      const pdf = await htmlToPdf(html, pdfPath);
      if (pdf) attachmentPath = pdf.path;
    } catch (e) {
      console.warn(`⚠ voucher unavailable for ${req.id} (${(e as Error).message}) — proceeding without attachment.`);
    }
  }

  // ARM LOCK, acquired immediately before the flow — the last point at which
  // "nothing has been submitted" is still provable. Everything above this line
  // fails closed on its own; from here on a crash cannot prove the push was
  // never armed, so the estate-wide hold has to already be on disk.
  //
  // FAIL CLOSED: if the lock cannot be written, we do not arm. A disk that
  // can't record the hold can't be trusted to prevent a double pay.
  const acquired = conservativeLock(req.id, Date.now());
  try {
    writeArmLock(acquired);
  } catch (e) {
    return mapFlowOutcomeToPatch({
      success: false,
      error: `Could not record the arm lock (${(e as Error).message}) — refusing to arm.`,
    });
  }

  // Duplicate-popup policy, decided HERE because this is the only place with
  // fs access to the queue archive — the flow itself is playwright-only and
  // never touches the filesystem. Scoped to THIS bundle (kbiz-fix-spec.md
  // §2.2 / decideDuplicateConfirm's own WHY): a scan we could not complete
  // (readPriorAttempts' `ok: false`) never licenses a confirm either.
  const dupScan = await readPriorAttempts(req.bundleId, req.id);
  const duplicatePolicy = decideDuplicateConfirm({
    bundleId: req.bundleId,
    scanOk: dupScan.ok,
    priorAttempts: dupScan.attempts,
    // MONEY REVIEW FINDING 2: also refuse on a same-destination-+-amount
    // match under a DIFFERENT bundle — see decideDuplicateConfirm's own doc
    // comment. `req` is this item's own (already-validated) destination, so
    // destinationSignature never has to guess at a redacted archive shape.
    destinationKey: destinationSignature(req as unknown as Record<string, unknown>),
    amount: req.amount,
    // MONEY REVIEW FINDING 6: bounds that same-destination-+-amount check to
    // SAME_MONEY_WINDOW_MS so a recurring same-payee/same-amount payment
    // (monthly rent) is not HELD forever.
    now: Date.now(),
  });
  const onDuplicatePopup = (info: { confirmed: boolean; reason: DuplicateReason; detail?: string }) =>
    notifySlack(
      duplicatePopupMessage({ id: req.id, bundleId: req.bundleId, confirmed: info.confirmed, reason: info.reason, detail: info.detail }),
    );

  const flow = await runTransferOtherFlow(page, {
    payee,
    amount: req.amount,
    memo: req.memo,
    attachmentPath,
    kbizCategoryId: req.kbizCategoryId,
    slug: req.id,
    maxTransfer: config.maxTransfer,
    confirm: true,
    onArmed,
    duplicatePolicy,
    onDuplicatePopup,
  });

  // RELEASE, only when the push is PROVABLY dead: consumed (success /
  // confirmed-failed / push-expired) or the bank's window provably elapsed
  // (timeout), or never armed at all. `pushMayBeLive` is true for exactly
  // THREE cases — session death, KBIZ's generic error page, and (NEW) an
  // unverified arm (verifyArmed returned "unknown": Next was clicked but the
  // bank's own "notification sent" panel was never seen within
  // ARM_VERIFY_TIMEOUT_MS, so we can prove neither that a push exists nor
  // that it doesn't) — and absent when Next was never clicked.
  //
  //   push-expired   → pushMayBeLive FALSE → released, resolution
  //                     "push-expired" (the bank's ~6-min window provably
  //                     closed — EXPIRY_CONFIRM_MS in approval-wait.ts).
  //   arm-unverified  → pushMayBeLive TRUE  → NOT released; the conservative
  //                     lock already on disk stands until it expires, exactly
  //                     like the two pre-existing "may still be live" exits.
  //
  // Note this is the flow's NORMAL return. A throw skips it deliberately (see
  // the catch in processBatch): the conservative lock stands until it expires.
  if (flow.pushMayBeLive !== true) {
    const resolution = flow.success ? "success" : (flow.outcome ?? "never-armed");
    // Base the released record on the REAL arm time when we have one, so the
    // audit trail says when the push actually existed rather than when we
    // guessed it might.
    const base = flow.armedAt !== undefined ? armedLock(req.id, flow.armedAt) : acquired;
    try {
      writeArmLock(releasedLock(base, resolution, Date.now()));
    } catch (e) {
      // Never let a release failure turn a finished transfer into a crash —
      // the stale lock simply expires on its own (≤10.5 min), which is the
      // safe direction.
      console.warn(`⚠ could not release the arm lock for ${req.id}: ${(e as Error).message}`);
    }
  }

  if (flow.success) {
    return {
      ...mapFlowOutcomeToPatch({
        success: true,
        reference: flow.reference,
        finalUrl: flow.finalUrl,
        slipFile: flow.slip ? slipFileBasename(flow.slip.screenshotPath) : undefined,
      }),
      armedAt: flow.armedAt,
      pushMayBeLive: flow.pushMayBeLive,
    };
  }
  // Straight pass-through (Seam B, kbiz-fix-spec.md §1.6) — the flow's own
  // `outcome` IS a TransferFailureOutcome (or absent, for a pre-arm failure),
  // and mapFlowOutcomeToPatch's exhaustive switch is where that four-way
  // split is actually decided. This used to launder it through a binary
  // ternary that silently collapsed anything that wasn't literally
  // "unconfirmed" — including a future outcome — into "confirmed-failed".
  return {
    ...mapFlowOutcomeToPatch({
      success: false,
      outcome: flow.outcome,
      error: flow.error,
      // SPEC REVIEW FINDING 8 (2026-08-19): `flow.reference` used to be
      // dropped here — the failure arm of TransferOtherResult carries it
      // precisely so a scraped reference (proof money moved, e.g. on the
      // push-expired→unconfirmed downgrade) reaches reimbursement/the
      // poller as structured data, not only inside the Thai prose.
      reference: flow.reference,
      slipFile: flow.shot ? slipFileBasename(flow.shot) : undefined,
    }),
    armedAt: flow.armedAt,
    pushMayBeLive: flow.pushMayBeLive,
  };
}

/**
 * Run every approved queue item on the RESIDENT keeper's page.
 *
 * CR-2026-09-17: this function no longer opens a browser. The keeper owns the
 * one persistent context for the process lifetime and hands its page in, so a
 * batch can start the instant work lands instead of paying a Chromium launch
 * and a bank login per poll. Nothing INSIDE the item loop changed: the gate,
 * the claim, the arm lock, the ordering and the phone tap are exactly as they
 * were.
 *
 * `onSessionDead` is how a failed warm-up reaches the keeper — the batch never
 * Slacks about a dead session itself, because the keeper already says it once
 * per death ("เซสชัน K BIZ หมดอายุแล้ว") and nudges while work waits.
 */
/** What the warm-up tells the keeper when it cannot get a session. `note` is
 *  already masked and truncated; `unclassified` says the failure carried none
 *  of the contract's death signals, so the keeper counts it instead of
 *  declaring a death (session-keeper-core.ts). */
export interface SessionDeadReport {
  note: string;
  unclassified: boolean;
}

async function processBatch(
  page: Page,
  hooks: { onSessionDead?: (report: SessionDeadReport) => void } = {},
): Promise<number> {
  const approved = await listApproved();
  if (approved.length === 0) return 0;

  console.log(`\n[${new Date().toISOString()}] Processing ${approved.length} approved request(s) …`);

  // Money items' 1-based position in THIS batch snapshot ("transfer 2/2").
  // The tap-needed alert carries it because a second push armed seconds after
  // the first tap raises no banner on the phone — the approver has to be told
  // to go look (2026-08-12 + 2026-08-13 incidents, both second-of-pair).
  const positions = transferOtherPositions(approved);

  // ONE Chromium session, sequential — KBIZ kills concurrent sessions. Since
  // CR-2026-09-17 it is the RESIDENT keeper's, shared with the keepalive ping
  // and the operator login, which is why the page arrives as a parameter.
  // Money transfers after the first in a batch get a deliberate gap before
  // their push is armed: TAP_COOLDOWN_MS (arm-gate.ts), unchanged at 90s but
  // now ALSO the cross-poll cooldown (kbiz-fix-spec.md §1.2/§2.4) — the value
  // is not re-tuned, only finally wired everywhere it needs to run. Its job
  // is giving the operator time to background/close the K BIZ app AFTER the
  // ping, not a bank-side timing requirement (a user-verified <1 min
  // back-to-back pair succeeded with the app closed, refuting that).
  // The previous MONEY item of this batch, as the gate sees it. Reset per
  // batch on purpose: cross-batch protection is the DURABLE arm lock's job
  // (an operator's Retry lands in a fresh batch 30 s later, with `prev` back
  // to "none" — only the on-disk lock can hold that one).
  let prev: PrevMoneyItem = { kind: "none" };
  // ── THE WARM-UP ───────────────────────────────────────────────────────────────
  // Prove the session FIRST, before the item loop, before any claim, before
  // any arm-lock write: a session we cannot get then costs nothing, because no
  // item has been touched and they all stay `approved`.
  //
  // Since CR-2026-09-17 this is a CHEAP, refuse-policy check, not a handoff.
  // The bot never summons a human on its own any more — the keeper reports the
  // death once, nudges while work waits, and an operator starts the login by
  // pressing the button on the QR page. A dead session here is therefore not an
  // error to Slack about: hand it to the keeper and leave the batch untouched.
  try {
    await ensureLoggedIn(page);
  } catch (e) {
    // MASKED, like every other note that reaches session.json: this string is
    // published to the Cloudflare-gated operator page, and a raw Playwright
    // error carries a multi-line call log plus the bank's own
    // `loginQR.do?cmd=<session token>` URL.
    hooks.onSessionDead?.({
      note: maskedNote(`warm-up failed: ${(e as Error).message}`),
      unclassified: !isSessionDeathError(e),
    });
    console.log(
      maskQrMessage(
        `⏸ ${approved.length} approved request(s) held — no K BIZ session (${(e as Error).message})`,
      ),
    );
    return approved.length;
  }

  for (const req of approved) {
    console.log(`\n=== ${req.id}  (${req.type}) ===`);

    // ── THE GATE ────────────────────────────────────────────────────────
    // Evaluated BEFORE the `running` claim below, so a held item is never
    // touched: no ":hourglass: Running", no page, no form, no Next.
    //
    // ALL THREE push-arming types go through it. transfer-other arms on
    // Next; transfer-payroll arms on Confirm; add-payroll arms on Next too
    // — KBIZ answers it with the review screen that literally says "A
    // notification has been sent to the K BIZ application", and the flow
    // then sits in waitForMobileConfirmation for 5 min exactly like the
    // other two. It moves no money, but it spends the SAME phone and the
    // same bank-side push, and a money push armed seconds after its tap
    // raises no banner at all (2026-08-12/13). Only list-favorites and
    // list-registered are genuinely push-free.
    let gapMs = 0;
    if (req.type === "transfer-other" || req.type === "transfer-payroll" || req.type === "add-payroll") {
      const now = Date.now();
      const { text, mtimeMs } = readArmLockRaw();
      const lock = parseArmLock(text, mtimeMs, now);
      if (lock.live === false && lock.source === "corrupt-unknown") {
        // Bounded by nothing (no content, no mtime) so we do NOT hold — but
        // this is the one lock state a human should look at.
        await notifySlack(
          `:rotating_light: The KBIZ arm lock is unreadable AND has no mtime — proceeding WITHOUT the one-push-at-a-time guard for \`${req.id}\`. Check /app/data/kbiz-arm-lock.json.`,
        );
      }
      const decision = decideArm({ prev, lock, now, gapMs: TAP_COOLDOWN_MS });
      if (decision.kind === "defer") {
        // Terminal status on purpose: a bare `break`/skip would leave the
        // item `approved` and the 30 s watch loop would re-pick it forever.
        // `failed` is exactly "nothing moved, retryable by a human" —
        // reimbursement returns the bundle to APPROVED with paymentError set
        // and never auto-re-queues it (kbiz-poller.ts).
        const dest = req.type === "transfer-other" ? describeDestination(req) : req.type;
        const amount = req.type === "transfer-other" ? req.amount : undefined;
        const errorText = deferredErrorText(decision, Date.now());
        // F7: a payroll-type defer must NOT get the transfer-other result
        // shape (`{outcome, ...}`, no `success` key). PayrollQueueRequest's
        // result is typed `{success: boolean; ...}` and the status view
        // branches on `req.result.success` — an omitted key falls to the
        // failure branch by JS coercion accident, not a real `success:false`.
        const patch =
          req.type === "transfer-other"
            ? mapFlowOutcomeToPatch({ success: false, error: errorText })
            : { status: "failed" as const, result: { success: false as const, error: errorText } };
        try {
          await patchRequest(req.id, { status: patch.status, result: patch.result, completedAt: new Date().toISOString() });
        } catch (e) {
          console.log(`↷ ${req.id} deferred but its queue file is gone: ${(e as Error).message}`);
        }
        await notifySlack(
          deferredMessage({ id: req.id, dest, amount, position: positions.get(req.id), decision, now: Date.now() }),
        );
        console.log(`⛔ ${req.id} HELD (${decision.code}) — nothing submitted`);
        // `prev` is deliberately NOT updated: a deferred item armed nothing.
        continue;
      }
      gapMs = decision.gapMs; // 0, or TAP_COOLDOWN_MS after a confirmed success
    }

    // The claim. listApproved() snapshots the queue up front and each
    // preceding transfer can wait minutes for a phone tap, so by the time we
    // get here the file may have been WITHDRAWN (reimbursement's stale-sweep
    // archives an intent the bot never started). A vanished file is a clean
    // per-item skip — it must never abort the rest of the batch.
    try {
      await patchRequest(req.id, { status: "running", startedAt: new Date().toISOString() });
    } catch (e) {
      console.log(`↷ ${req.id} skipped — queue file gone before claim (withdrawn?): ${(e as Error).message}`);
      continue;
    }
    await notifySlack(`:hourglass_flowing_sand: Running \`${req.id}\` (${req.type})`);

    if (req.type === "transfer-other") {
      // bank + last 4 for a custom destination — a full account number has
      // no business in Slack. See describeDestination.
      const dest = describeDestination(req);
      // The gap is now spent only after an ACTUALLY ARMED previous push
      // (decideArm returns 0 otherwise) — a payee-handle typo on item 1 no
      // longer costs item 2 a pointless 90 s.
      if (gapMs > 0) {
        await notifySlack(
          pauseBeforeArmMessage({
            dest,
            amount: req.amount,
            gapSeconds: Math.round(gapMs / 1000),
            position: positions.get(req.id),
          }),
        );
        await new Promise((r) => setTimeout(r, gapMs));
      }
      // Never throws. SPEC REVIEW FINDING 6 (2026-08-19): this comment used
      // to say the ping "fires at the exact moment Next is clicked (push
      // armed)" — that stopped being true the moment IMPL-D moved onArmed
      // to fire only AFTER verifyArmed confirms the bank's own panel (see
      // the paragraph below); a stale claim on the money-path arm seam is
      // exactly the kind of thing the next diagnosis would trust.
      //
      // The lock refinement is issued SYNCHRONOUSLY right after the Slack
      // fetch is kicked off, deliberately NOT behind `await notifySlack(…)`:
      // a hung webhook would otherwise delay this write past the flow's own
      // release and re-arm an already-dead lock.
      // `armedAt` is the CLICK time (kbiz-fix-spec.md §1.6/§2.3), not the
      // moment this callback runs — IMPL-D now fires it only AFTER
      // verifyArmed confirms the bank's "notification sent" panel, which is
      // deliberately LATER than the click by design. The lock's window has
      // to reflect when the push actually started counting down at the
      // bank, not when we happened to finish confirming it exists.
      const onArmed = (armedAt: number) => {
        const posted = notifySlack(
          tapNeededMessage({ id: req.id, dest, amount: req.amount, position: positions.get(req.id) }),
        );
        try {
          writeArmLock(armedLock(req.id, armedAt));
        } catch {
          // Best-effort: the conservative lock written before the flow is
          // the safety net, and it is already on disk.
        }
        return posted;
      };
      try {
        const patch = await runTransferOtherQueueItem(page, req, onArmed);
        await patchRequest(req.id, { status: patch.status, result: patch.result, completedAt: new Date().toISOString() });
        const icon = patch.status === "done" ? "✅" : patch.status === "needs-review" ? "⚠️" : "❌";
        const slackIcon = patch.status === "done" ? ":white_check_mark:" : patch.status === "needs-review" ? ":warning:" : ":x:";
        const detail = patch.result.error ? ` — ${patch.result.error}` : patch.result.reference ? ` → ${patch.result.reference}` : "";
        // An unconfirmed exit that left the push TAPPABLE is the one case
        // where "Retry" is the wrong button — say so on the same line.
        const liveWarning =
          patch.result.outcome === "unconfirmed" && patch.pushMayBeLive === true && patch.armedAt !== undefined
            ? livePushWarning(patch.armedAt + PUSH_LIFETIME_MS)
            : "";
        await notifySlack(
          `${slackIcon} ${patch.status} \`${req.id}\` (transfer-other → ${dest}, bundle ${req.bundleId})${detail}${liveWarning}`,
        );
        console.log(`${icon} ${req.id} ${patch.status}`);
        // What the NEXT money item's gate sees. `armedAt` is the only signal
        // that separates "never armed" (a pre-flight failure — must not hold
        // the batch) from "the bank said no" (must).
        // No cast: patch.result.outcome (the contract's four-way union,
        // shared/index.ts:549) and PrevMoneyItem's `outcome` (approval-wait
        // .ts's TransferOutcome) are now the SAME four literal strings, so
        // this is a structural fit. If this stops typechecking, the two
        // unions have genuinely diverged — that is a real bug to report,
        // not a cast to restore (kbiz-fix-spec.md §1.6).
        prev = patch.armedAt !== undefined
          ? { kind: "armed", id: req.id, outcome: patch.result.outcome }
          : { kind: "not-armed", id: req.id };
      } catch (e) {
        // Unknown crash: we cannot prove the phone push was never armed, so
        // this is filed as needs-review (never auto-retried), not failed —
        // the same "ambiguity is never auto-resolved" rule the flow itself
        // uses for a timeout. See money-safety invariant 2 in the ADR.
        //
        // THE ARM LOCK IS DELIBERATELY NOT RELEASED HERE. A crash after the
        // Next click cannot prove the push is dead, so the conservative lock
        // written before the flow stands until it expires (≤10.5 min) and
        // every later item — this batch or the next poll — is held.
        const error = (e as Error).message;
        const patch = mapFlowOutcomeToPatch({ success: false, outcome: "unconfirmed", error: `Crashed: ${error}` });
        await patchRequest(req.id, { status: patch.status, result: patch.result, completedAt: new Date().toISOString() });
        await notifySlack(
          `:warning: Crashed \`${req.id}\` (transfer-other → ${dest}, bundle ${req.bundleId}) → needs-review — ${error}`,
        );
        console.log(`⚠️ ${req.id} crashed → needs-review: ${error}`);
        // Treated as ARMED + unconfirmed: a crash cannot prove otherwise,
        // so the rest of the batch is held (belt to the lock's braces).
        prev = { kind: "armed", id: req.id, outcome: "unconfirmed" };
      }
      continue;
    }

    // A read-only scrape: nothing can move, so a failure is always just
    // "failed" (retryable), never the ambiguous needs-review a transfer has.
    if (req.type === "list-favorites") {
      // The completion patch may find the file GONE (reimbursement's
      // staleness sweep can archive an old ask) — the scrape's real output
      // is kbiz-favorites.json, which was already published, so a vanished
      // status file is a shrug, never a batch-abort.
      try {
        const count = await runListFavorites(page);
        await patchRequest(req.id, {
          status: "done",
          completedAt: new Date().toISOString(),
          result: { success: true, count },
        }).catch((e) =>
          console.log(`↷ ${req.id} finished but its queue file is gone (${(e as Error).message}) — manifest published anyway`),
        );
        await notifySlack(`:white_check_mark: Done \`${req.id}\` (list-favorites) → ${count} saved account(s)`);
        console.log(`✅ ${req.id} done`);
      } catch (e) {
        const error = (e as Error).message;
        await patchRequest(req.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          result: { success: false, error },
        }).catch(() => console.log(`↷ ${req.id} failed and its queue file is gone`));
        await notifySlack(`:x: Failed \`${req.id}\` (list-favorites) — ${error}`);
        console.log(`❌ ${req.id} failed: ${error}`);
      }
      continue;
    }

    // list-registered has no workbook (xlsxPath is "")
    const xlsxAbs = req.xlsxPath.startsWith("data/") ? resolve("..", req.xlsxPath) : resolve(req.xlsxPath);

    // transfer-payroll AND add-payroll both ARM A PHONE PUSH (Confirm →
    // waitForMobileConfirmation, and Next → the "notification has been sent"
    // review screen → waitForMobileConfirmation, respectively), so both take
    // the same estate-wide lock as a transfer-other. Fail closed exactly the
    // same way: no lock, no push. list-registered arms nothing and takes no
    // lock.
    let pushLock: ArmLock | undefined;
    if (req.type === "transfer-payroll" || req.type === "add-payroll") {
      // F4: the same deliberate gap + operator warning the transfer-other
      // branch spends above — `gapMs` was already decided by THE GATE for
      // every gated type, but only transfer-other used to read it, so a
      // payroll item following an armed push used to arm seconds after the
      // previous tap with no pause and no "background the app" warning. A
      // payroll workbook has no single amount to name, so the pause message
      // names the request type in place of ฿amount → dest.
      if (gapMs > 0) {
        await notifySlack(
          pauseBeforeArmMessage({ dest: req.type, gapSeconds: Math.round(gapMs / 1000), position: positions.get(req.id) }),
        );
        await new Promise((r) => setTimeout(r, gapMs));
      }
      const candidate = conservativeLock(req.id, Date.now());
      try {
        writeArmLock(candidate);
        pushLock = candidate;
      } catch (e) {
        const error = `Could not record the arm lock (${(e as Error).message}) — refusing to arm.`;
        await patchRequest(req.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          result: { success: false, error },
        }).catch(() => console.log(`↷ ${req.id} failed and its queue file is gone`));
        await notifySlack(`:x: Failed \`${req.id}\` (${req.type}) — ${error}`);
        console.log(`❌ ${req.id} failed: ${error}`);
        continue;
      }
    }

    try {
      const result =
        req.type === "list-registered"
          ? await runListRegistered(page)
          : req.type === "transfer-payroll"
            ? await runTransferPayrollFlow(page, xlsxAbs)
            : await runAddPayrollFlow(page, xlsxAbs);

      // RELEASE, only on a PROVABLY DEAD outcome — the same rule
      // runTransferOtherQueueItem uses, expressed through the same
      // `pushMayBeLive` flag.
      //
      // Payroll succeeds only on the bank's expected confirmation page.
      // An auth/error redirect sets pushMayBeLive because it proves neither
      // acceptance nor a dead push. Pre-Confirm refusals remain never armed.
      // Add-payroll also sets the flag when neither a rejection popup nor
      // the notification screen appears after Next.
      // The `catch` below deliberately releases nothing: a throw (including
      // a 5-minute waitForMobileConfirmation timeout) cannot prove the push
      // is dead, so the conservative lock stands until it expires.
      const pushMayBeLive = "pushMayBeLive" in result && result.pushMayBeLive === true;
      if (pushLock && !pushMayBeLive) {
        try {
          writeArmLock(releasedLock(pushLock, result.success ? "success" : "confirmed-failed", Date.now()));
        } catch (e) {
          console.warn(`⚠ could not release the arm lock for ${req.id}: ${(e as Error).message}`);
        }
      }

      if (result.success) {
        await patchRequest(req.id, {
          status: "done",
          completedAt: new Date().toISOString(),
          result: { success: true, finalUrl: result.finalUrl, ...("bankReferenceNo" in result ? { bankReferenceNo: result.bankReferenceNo } : {}) },
        });
        await notifySlack(`:white_check_mark: Done \`${req.id}\` (${req.type}) → ${result.finalUrl}`);
        console.log(`✅ ${req.id} done`);
      } else {
        await patchRequest(req.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          result: { success: false, error: result.error },
        });
        await notifySlack(`:x: Failed \`${req.id}\` (${req.type}) — ${result.error}`);
        console.log(`❌ ${req.id} failed: ${result.error}`);
      }
      // F4: what the NEXT money item's gate sees — mirrors the assignment
      // in the transfer-other branch above. list-registered arms nothing,
      // so it must never touch `prev`. `pushMayBeLive` is the only signal
      // (for BOTH flows — see the comment above) that separates "never
      // armed" from "armed but unresolved". An uncertain payroll redirect
      // must hold later pushes just like an uncertain add-payroll result.
      if (pushLock) {
        prev = result.success
          ? { kind: "armed", id: req.id, outcome: "success" }
          : pushMayBeLive
            ? { kind: "armed", id: req.id, outcome: "unconfirmed" }
            : { kind: "not-armed", id: req.id };
      }
    } catch (e) {
      // A transfer-payroll / add-payroll crash leaves its arm lock STANDING
      // on purpose — see the release above.
      const error = (e as Error).message;
      await patchRequest(req.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        result: { success: false, error },
      });
      await notifySlack(`:x: Crashed \`${req.id}\` (${req.type}) — ${error}`);
      console.log(`❌ ${req.id} crashed: ${error}`);
      // F4: same as the transfer-other crash handler — cannot prove the
      // push is dead, so the rest of the batch is held (belt to the lock's
      // braces). list-registered never took a lock, so never touches prev.
      if (pushLock) prev = { kind: "armed", id: req.id, outcome: "unconfirmed" };
    }
  }

  return approved.length;
}

// ── The resident loop ────────────────────────────────────────

/** Where the operator presses the button. Same env the QR driver reads. */
const QR_PAGE_URL = process.env.KBIZ_QR_PAGE_URL ?? DEFAULT_QR_PAGE_URL;

/** A positive number of milliseconds, or the default — an empty, unparseable
 *  or zero/negative override must never turn a cadence into a tight loop. */
function positiveMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function keeperConfig(): KeeperConfig {
  return {
    tickMs: positiveMs(process.env.KBIZ_TICK_MS, DEFAULT_TICK_MS),
    keepaliveMs: positiveMs(process.env.KBIZ_KEEPALIVE_MS, DEFAULT_KEEPALIVE_MS),
    // The queue keeps its own env var and its own 30 s default, unchanged.
    queuePollMs: positiveMs(process.env.QUEUE_POLL_MS, DEFAULT_QUEUE_POLL_MS),
    reminderMinuteOfDay: parseReminderHhmm(process.env.KBIZ_LOGIN_REMINDER_HHMM ?? DEFAULT_REMINDER_HHMM),
  };
}

async function main() {
  const watch = process.argv.includes("--watch");

  if (!watch) {
    // The one-shot path. No browser unless there is something to do with it
    // (an empty queue still costs no Chromium launch, exactly as before), and
    // the SAME refuse-policy warm-up the watch loop runs — no script asks for a
    // QR scan on its own any more; `npm run login` is the operator's handoff,
    // and the page's button is production's.
    await publishPayeeHandles(QUEUE_DIR);
    if ((await listApproved()).length === 0) {
      console.log("No approved requests in queue.");
      // Its own `withSession`, and only if it finds a run that is actually due.
      await checkPayrollBankSettlements(QUEUE_DIR);
      return;
    }
    const oneShot = createSessionKeeper();
    await oneShot.open();
    try {
      await processBatch(oneShot.page());
      await checkPayrollBankSettlements(QUEUE_DIR, new Date(), { page: oneShot.page() });
    } finally {
      await oneShot.close();
    }
    return;
  }

  // ONE persistent context for the whole process (CR-2026-09-17). Deliberately
  // no SIGTERM/SIGINT handler of our own: playwright already closes the browser
  // on `docker stop`, and a second handler would race it for the same context.
  const keeper = createSessionKeeper();

  const config = keeperConfig();
  const tickMs = config.tickMs;
  // Seeded, not bare: `lastReminderDay` lives only in memory, so a process that
  // starts after 08:30 Bangkok on a logged-out day would otherwise post the
  // sunrise line at 14:00 — and again at every later restart that day.
  let state: KeeperState = seedReminderDay(initialKeeperState(), Date.now(), config);
  /** Approved items as of the last queue step — what the nudge counts. */
  let approvedCount = 0;
  /** A QR handoff owns the single page while it runs. */
  let handoffInProgress = false;

  /** Publish what we know. Never throws: a full disk must not take the loop
   *  down, and the page degrades to its "no session info" state on its own. */
  const publish = () => {
    try {
      writeSessionFile(sessionFileFrom(state));
    } catch (e) {
      console.warn(`⚠ could not write session.json: ${(e as Error).message}`);
    }
  };

  const post = async (action: KeeperAction, pending: number = approvedCount) => {
    const line = keeperSlackLine(action, {
      pageUrl: QR_PAGE_URL,
      lifetimeMs: state.lastLifetimeMs,
      pending,
    });
    if (line) await notifySlack(line);
  };

  /** Fold a bank round-trip into the state, publish it, and say the one thing
   *  a death is allowed to say (once). */
  const applyCheck = async (result: KeeperCheckResult, nowMs: number = Date.now()) => {
    const folded = applyCheckResult(state, {
      nowMs,
      alive: result.alive,
      note: result.note,
      unclassified: result.unclassified,
    });
    state = folded.state;
    publish();
    for (const action of folded.actions) await post(action);
  };

  /**
   * The 30 s queue step: handles, the batch (only on a live session), the
   * pending count both the nudge and `session.json` read, and — still only on
   * a live session — the read-only payroll settlement check, now on the
   * keeper's page instead of a second browser of its own.
   */
  const runQueueStep = async () => {
    await publishPayeeHandles(QUEUE_DIR).catch((e) =>
      console.warn(`⚠ could not publish payee handles: ${(e as Error).message}`),
    );

    if (isAlive(state)) {
      // The warm-up reports a dead session through this hook instead of
      // throwing: the items stay `approved` and untouched either way.
      const dead: { report: SessionDeadReport | null } = { report: null };
      await processBatch(keeper.page(), {
        onSessionDead: (report) => {
          dead.report = report;
        },
      });
      if (dead.report !== null) {
        await applyCheck({ alive: false, note: dead.report.note, unclassified: dead.report.unclassified });
      }
    }

    approvedCount = (await listApproved()).length;
    if (approvedCount !== state.pending) {
      state = setPending(state, approvedCount);
      publish();
    }

    if (isAlive(state)) {
      await checkPayrollBankSettlements(QUEUE_DIR, new Date(), { page: keeper.page() }).catch(() =>
        console.warn("Payroll bank status check unavailable."),
      );
    }
  };

  const tick = async () => {
    const nowMs = Date.now();
    const request = readLoginRequest();
    const decided = decideTick(
      state,
      {
        nowMs,
        alive: isAlive(state),
        requestPresent: request !== null,
        handoffInProgress,
        approvedCount,
        browserOpen: keeper.isOpen(),
      },
      config,
    );
    state = decided.state;
    // The count `decideTick` decided with — and stamped into `lastNudgeCount`.
    // `runQueueStep` refreshes `approvedCount` further down the SAME action
    // array, so posting the fresh number against a stamp of the stale one would
    // make the next tick see a "changed" count and repeat the identical line
    // 5 s later (or name work that was withdrawn during the step).
    const nudgeCount = approvedCount;

    for (const action of decided.actions) {
      switch (action) {
        case "reopen-browser": {
          console.log("↻ K BIZ browser context is gone — reopening it");
          try {
            await keeper.reopen();
            state = markReopened(withNote(state, "browser restarted"), true);
          } catch (e) {
            // A launch can fail for reasons a retry will not fix in 5 s (a
            // profile lock held by a stray `npm run login`, no disk, no
            // /dev/shm). The reducer backs the next attempt off — one tick,
            // then 2, 4, 8 … up to the keepalive interval — instead of
            // launching Chromium 12×/min forever. Nothing else runs this tick:
            // every remaining action needs the page we just failed to get.
            console.warn(`⚠ could not reopen the K BIZ browser: ${(e as Error).message}`);
            state = markReopened(withNote(state, maskedNote(`browser unavailable: ${(e as Error).message}`)), false);
            publish();
            return;
          }
          publish();
          break;
        }
        case "claim-and-login": {
          // CLAIM BEFORE THE BANK IS TOUCHED — the same rule
          // payroll-bank-backfill.ts follows: a crash, an outage or an
          // unscanned QR can never turn one press of the button into an
          // endless retry loop. A rename that finds nothing (the file vanished
          // between the read and here) is simply not our request.
          if (!claimLoginRequest()) break;
          const by = request?.by ?? "unknown";
          console.log(`→ K BIZ login requested by ${by}`);
          handoffInProgress = true;
          let result: KeeperCheckResult;
          try {
            result = await keeper.login(`login requested by ${by}`);
          } finally {
            handoffInProgress = false;
          }
          await applyCheck(result);
          // The handoff posts its own :lock:/:white_check_mark: lines; these
          // two are the cases it has nothing to say about.
          if (result.alreadyAlive) await notifySlack(sessionAliveMessage());
          else if (result.timedOut) await notifySlack(qrTimeoutMessage());
          break;
        }
        case "keepalive-check": {
          await applyCheck(await keeper.check());
          break;
        }
        case "run-queue": {
          await runQueueStep();
          // Restamp on COMPLETION: a batch can sit on a phone tap for minutes,
          // and the next tick should not poll again the instant it returns.
          state = markQueueRan(state, Date.now());
          break;
        }
        case "nudge": {
          await post(action, nudgeCount);
          break;
        }
        case "reminder": {
          await post(action);
          break;
        }
        case "session-ended": {
          // applyCheckResult owns this one; decideTick never emits it.
          break;
        }
      }
    }
  };

  console.log(
    `Watching ${resolve(QUEUE_DIR)} — tick ${tickMs}ms, keepalive ${config.keepaliveMs}ms, ` +
      `queue ${config.queuePollMs}ms. Ctrl+C to stop.`,
  );
  // The startup launch is allowed to FAIL. The pre-CR watch loop survived one
  // (it caught inside processBatch and retried at the next poll); exiting here
  // instead would crash-loop the container and publish nothing at all, so the
  // operator page would show no session info rather than a dead session. On a
  // failure we say so in `session.json` and fall into the tick loop, which
  // emits `reopen-browser` (with backoff) and recovers on its own.
  try {
    await keeper.open();
  } catch (e) {
    console.error(`❌ could not open the K BIZ browser: ${(e as Error).message}`);
    state = markReopened(withNote(state, maskedNote(`browser unavailable: ${(e as Error).message}`)), false);
    publish();
  }

  // The first check publishes session.json within a tick of startup, so the
  // operator page stops guessing the moment the container is up.
  if (keeper.isOpen()) await applyCheck(await keeper.check());

  while (true) {
    try {
      await tick();
    } catch (e) {
      console.error("tick error:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, tickMs));
  }
}

main().catch((e) => {
  console.error("❌", (e as Error).message);
  process.exit(1);
});
