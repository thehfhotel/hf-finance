import {
  readPayrollVerificationQueue,
  patchPayrollVerification,
} from "./payroll-bank-files";
import { readArmLockRaw } from "./arm-lock";
import { parseArmLock } from "./arm-gate";
import { decidePayrollBankVerification, type PayrollBankBatch } from "./payroll-bank-core";
import { payrollBankCheckDue } from "./payroll-bank-schedule";
import { readPayrollBackfillRequest, claimPayrollBackfillRequest } from "./payroll-bank-backfill";
import {
  bangkokPayrollDate,
  canonicalPayrollInstant,
  validatePayrollTransfer,
} from "../../../src/payroll-settlement";

type HistoryQuery = { startDate: string; endDate: string; candidateDates: Set<string> };
export type PayrollBankCheckOptions = {
  since?: unknown;
  readArmLock?: () => ReturnType<typeof readArmLockRaw>;
  readHistory?: (query: HistoryQuery) => Promise<PayrollBankBatch[]>;
  /**
   * The resident session keeper's Playwright Page (CR-2026-09-17). Typed
   * `unknown` on purpose: this module is imported by tests that run BEFORE
   * kbiz-bot's node_modules exist, so it must stay playwright-free even in its
   * type positions. Supplied → the read-only history check rides the one warm
   * session instead of launching a second browser and a second bank login.
   * Omitted → the pre-existing `withSession` path, for the one-shot CLIs.
   */
  page?: unknown;
};

/** Loaded only after all disk-only scheduling and money-session guards pass. */
async function readHistoryWithSession(query: HistoryQuery): Promise<PayrollBankBatch[]> {
  const { withSession } = await import("./session");
  const { readPayrollBankHistory } = await import("./payroll-bank-reader");
  return withSession(async (_ctx, page) => readPayrollBankHistory(page, query));
}

/**
 * Same read, on a page somebody else owns. Read-only exactly as before: it
 * never starts a competing login, never arms a push and never touches a
 * transfer/approval API — sharing the keeper's page changes WHICH browser the
 * inquiry runs in, nothing about what it is allowed to do.
 */
async function readHistoryWithPage(page: unknown, query: HistoryQuery): Promise<PayrollBankBatch[]> {
  const { readPayrollBankHistory } = await import("./payroll-bank-reader");
  return readPayrollBankHistory(page as Parameters<typeof readPayrollBankHistory>[0], query);
}

/**
 * Called only by the existing serialized queue loop, outside its money session.
 * Tests inject the bank reader; they never import/launch the browser stack.
 */
export async function checkPayrollBankSettlements(
  queueDir: string,
  now = new Date(),
  options: PayrollBankCheckOptions = {},
): Promise<void> {
  const since = options.since ?? process.env.PAYROLL_BANK_VERIFY_SINCE;
  if (!canonicalPayrollInstant(since) || !Number.isFinite(now.getTime())) return;
  const all = await readPayrollVerificationQueue(queueDir);
  if (
    all.some(
      (r) => !r.archived &&
        (r.value.status === "approved" || r.value.status === "running"),
    )
  ) return;
  const raw = (options.readArmLock ?? readArmLockRaw)();
  const lock = parseArmLock(raw.text, raw.mtimeMs, now.getTime());
  if (lock.live || !["none", "released", "expired"].includes(lock.source)) return;

  const backfill = await readPayrollBackfillRequest(queueDir);
  const valid = all.filter(
    ({ archived, value }) => !archived &&
      (!backfill?.requestId || value.id === backfill.requestId) &&
      payrollBankCheckDue(value, since, now, backfill ? "backfill" : "automatic"),
  );
  // Claim even an empty one-shot request, but never claim under a busy queue or
  // live/unknown arm lock. A restart/outage cannot replay historical backfills.
  if (backfill) {
    if (!await claimPayrollBackfillRequest(queueDir, backfill)) return;
    console.log(`Payroll bank backfill claimed (${valid.length} eligible run(s)).`);
  }
  if (!valid.length) return;

  const today = bangkokPayrollDate(now);
  const dates = new Set(valid.map((r) => validatePayrollTransfer(r.value).effectiveDate));
  const minDate = valid
    .map((r) => bangkokPayrollDate(new Date(String(r.value.createdAt))))
    .sort()[0];
  const display = (d: string) => d.split("-").reverse().join("/");
  let batches: PayrollBankBatch[];
  try {
    const readHistory =
      options.readHistory ??
      (options.page === undefined
        ? readHistoryWithSession
        : (q: HistoryQuery) => readHistoryWithPage(options.page, q));
    batches = await readHistory({
      startDate: display(minDate),
      endDate: display(today),
      candidateDates: dates,
    });
  } catch {
    for (const r of valid)
      await patchPayrollVerification(r, {
        payrollVerification: {
          status: "UNKNOWN",
          reasonCode: "BANK_CHECK_UNAVAILABLE",
          checkedAt: now.toISOString(),
        },
      });
    console.warn("Payroll bank verification unavailable; no payment status changed.");
    return;
  }
  // Retain EVERY queue/archive record for ownership/duplicate checks, not just
  // the scheduled subset. Scheduling must never weaken settlement evidence.
  const input = all.map((r) => r.value);
  for (const r of valid) {
    const result = decidePayrollBankVerification(r.value, batches, input, now);
    await patchPayrollVerification(r, result);
    Object.assign(r.value, result);
  }
  console.log(`Payroll bank verification checked ${valid.length} run(s).`);
}
