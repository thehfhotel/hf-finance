import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Page } from "playwright";
import { withSession, gotoAuthenticated, ensureLoggedIn } from "./lib/session";
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
  maskQrMessage,
  QrLoginTimeoutError,
  QR_COOLDOWN_MS,
  qrTimeoutMessage,
  shouldAttemptLogin,
} from "./lib/qr-login-core";
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

/**
 * When the last batch warm-up failed to get a session (nobody scanned, or the
 * login failed for any other reason). In-process on purpose (unlike the arm
 * lock, which MUST be durable): a restart is a human act, and a human who just
 * restarted the bot is exactly the human who is about to scan. Nothing here
 * can double-pay — the cooldown only decides whether to ASK for a scan.
 */
let lastLoginFailAt: number | null = null;

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

async function processBatch(): Promise<number> {
  const approved = await listApproved();
  if (approved.length === 0) return 0;

  // A failed handoff means nobody is at the computer. Asking again 30 s later
  // would republish a QR nobody is waiting for and re-ping Slack every poll,
  // so the whole batch is skipped — quietly, one log line, no Slack — until
  // the cooldown runs out. Nothing is claimed, so every item stays `approved`
  // and the next successful warm-up picks the same batch up untouched.
  if (!shouldAttemptLogin(Date.now(), lastLoginFailAt)) {
    const waitS = Math.ceil((QR_COOLDOWN_MS - (Date.now() - lastLoginFailAt!)) / 1000);
    console.log(`⏸ ${approved.length} approved request(s) held — waiting ${waitS}s before asking K BIZ to log in again`);
    return approved.length;
  }

  console.log(`\n[${new Date().toISOString()}] Processing ${approved.length} approved request(s) …`);

  // Money items' 1-based position in THIS batch snapshot ("transfer 2/2").
  // The tap-needed alert carries it because a second push armed seconds after
  // the first tap raises no banner on the phone — the approver has to be told
  // to go look (2026-08-12 + 2026-08-13 incidents, both second-of-pair).
  const positions = transferOtherPositions(approved);

  // Single Chromium session, sequential — KBIZ kills concurrent sessions.
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
  // Set only once the warm-up has a confirmed session. The catch below uses it
  // to tell "we never got a session" (launch failure, wrong password, bank
  // outage — nothing claimed, so it must be REPORTED or the batch stalls
  // invisibly) from a throw after items were already being processed (the
  // pre-existing behaviour, left exactly as it was).
  let warmedUp = false;
  try {
    await withSession(async (_ctx, page) => {
      // ── THE WARM-UP ─────────────────────────────────────────────────────
      // Log in FIRST, before the item loop, before any claim, before any
      // arm-lock write: a scan we cannot get then costs nothing, because no
      // item has been touched and they all stay `approved`. The login used to
      // happen lazily inside the first item's gotoAuthenticated, which crashed
      // whichever item happened to be first (`running`, then `failed`) and left
      // its conservative arm lock standing for ~10 min.
      //
      // This is the ONE queue path allowed to summon a human ("handoff"). The
      // payroll settlement check that runs after this batch keeps the default
      // "refuse" — a QR page makes it give up at once into its existing
      // BANK_CHECK_UNAVAILABLE + 6-hour retry.
      await ensureLoggedIn(page, { onQr: "handoff", reason: `${approved.length} approved item(s)` });
      lastLoginFailAt = null;
      warmedUp = true;

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
    });
  } catch (e) {
    // A throw AFTER the warm-up is an item-level problem the item loop has
    // already reported — pass it straight on, exactly as before.
    if (warmedUp) throw e;
    // We never had a session: nobody scanned, or the login failed for another
    // reason (a wrong password, a bank outage, "After re-login still
    // bouncing") — including Chromium failing to launch, which happens inside
    // withSession before the callback above ever runs. Nothing was claimed, so
    // the batch would otherwise sit at `approved` forever with the failure
    // visible only in a container log nobody reads. The cooldown rate-limits
    // this to one line per 10 min.
    lastLoginFailAt = Date.now();
    if (e instanceof QrLoginTimeoutError) {
      // The contract's Thai line, and no rethrow: the items are untouched and
      // the next ask is bounded by the cooldown.
      await notifySlack(qrTimeoutMessage());
      console.log(`⛔ no K BIZ QR scan — ${approved.length} request(s) left approved, retrying in 10 min`);
      return approved.length;
    }
    // English (the contract fixes Thai copy for its three defined lines only)
    // and masked — an error string can carry the bank's `loginQR.do?cmd=<token>`.
    await notifySlack(
      maskQrMessage(
        `:x: kbiz-bot: K BIZ login failed (${approved.length} approved item(s)) — ` +
          `${(e as Error).message}; retrying in 10 min`,
      ),
    );
    throw e;
  }
  return approved.length;
}

async function main() {
  const watch = process.argv.includes("--watch");
  const intervalMs = Number(process.env.QUEUE_POLL_MS ?? 30_000);

  if (!watch) {
    await publishPayeeHandles(QUEUE_DIR);
    const n = await processBatch();
    if (n === 0) console.log("No approved requests in queue.");
    await checkPayrollBankSettlements(QUEUE_DIR);
    return;
  }

  console.log(`Watching ${resolve(QUEUE_DIR)} — polling every ${intervalMs}ms. Ctrl+C to stop.`);
  // First pass immediately
  await publishPayeeHandles(QUEUE_DIR);
  await processBatch().catch((e) => console.error("batch error:", (e as Error).message));
  await checkPayrollBankSettlements(QUEUE_DIR).catch(() => console.warn("Payroll bank status check unavailable."));
  // Then loop
  while (true) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      // mtime-gated: republishes only when the payee book changed, so editing
      // it on the host reaches the admin dropdown within one poll interval.
      await publishPayeeHandles(QUEUE_DIR);
      await processBatch();
      await checkPayrollBankSettlements(QUEUE_DIR).catch(() => console.warn("Payroll bank status check unavailable."));
    } catch (e) {
      console.error("batch error:", (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error("❌", (e as Error).message);
  process.exit(1);
});
