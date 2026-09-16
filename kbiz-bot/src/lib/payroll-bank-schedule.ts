import {
  canonicalPayrollInstant,
  payrollObject,
  validatePayrollTransfer,
} from "../../../src/payroll-settlement";

export const PAYROLL_VERIFY_RETRY_MS = 6 * 60 * 60_000;
export const PAYROLL_VERIFY_WINDOW_MS = 7 * 24 * 60 * 60_000;
export type PayrollCheckMode = "automatic" | "backfill";

/**
 * Pure scheduling policy. Queue status `done` is submission, not bank proof;
 * queue status `failed` can also be an uncertain browser outcome. Only the
 * matcher's BANK_FAILED verdict stops retries as a confirmed bank failure.
 * Old unresolved runs stay unresolved; aging out never marks anything paid.
 */
export function payrollBankCheckDue(
  value: unknown,
  since: unknown,
  now: Date,
  mode: PayrollCheckMode = "automatic",
): boolean {
  const r = payrollObject(value);
  const nowMs = now.getTime();
  if (
    !r || !Number.isFinite(nowMs) || !canonicalPayrollInstant(since) ||
    !canonicalPayrollInstant(r.createdAt) || r.createdAt < since ||
    !canonicalPayrollInstant(r.startedAt) || r.startedAt < r.createdAt ||
    Date.parse(r.startedAt) > nowMs || r.payrollSettlement ||
    !["done", "failed", "needs-review"].includes(String(r.status))
  ) return false;

  let effectiveDate: string;
  try {
    effectiveDate = validatePayrollTransfer(r).effectiveDate;
  } catch {
    return false;
  }
  // Bangkok midnight, not the host's timezone. A future payroll upload must
  // not keep logging into the bank before the actual pay date arrives.
  const firstDue = Math.max(
    Date.parse(`${effectiveDate}T00:00:00.000+07:00`),
    Date.parse(r.startedAt),
  );
  if (nowMs < firstDue) return false;

  const verification = payrollObject(r.payrollVerification);
  const checkedAt = canonicalPayrollInstant(verification?.checkedAt)
    ? Date.parse(verification.checkedAt) : null;
  if (
    verification?.status === "FAILED" &&
    verification.reasonCode === "BANK_FAILED" &&
    checkedAt !== null && checkedAt >= firstDue && checkedAt <= nowMs
  ) return false;

  // An explicitly queued backfill is one pass, never a permanent watch mode.
  // It still cannot recheck settled/confirmed-failed or future-dated runs.
  if (mode === "backfill") return true;
  if (nowMs >= firstDue + PAYROLL_VERIFY_WINDOW_MS) return false;
  // Persisted checkedAt survives restarts. A pre-payday SCHEDULED check must
  // not delay the first actual payday check; a future timestamp fails closed.
  return checkedAt === null || checkedAt < firstDue ||
    checkedAt + PAYROLL_VERIFY_RETRY_MS <= nowMs;
}
