import { describe, expect, test } from "bun:test";
import { payrollBankCheckDue, PAYROLL_VERIFY_RETRY_MS, PAYROLL_VERIFY_WINDOW_MS } from "../src/lib/payroll-bank-schedule";

const since = "2026-09-01T00:00:00.000Z";
const now = new Date("2026-09-16T05:00:00.000Z");
const firstDue = Date.parse("2026-09-15T17:00:00.000Z");
function sample() {
  return {
    id: "sample", type: "transfer-payroll", status: "done",
    createdAt: "2026-09-15T00:00:00.000Z", startedAt: "2026-09-15T00:01:00.000Z",
    result: { success: true },
    summary: { type: "transfer-payroll", period: "2026-09", effectiveDate: "16/09/2026",
      totalAmount: 100, rows: [{ accountNumber: "0000000001", amount: 100 }] },
  };
}
function checked(status: string, reasonCode: string, checkedAt = now.toISOString()) {
  return { ...sample(), payrollVerification: { status, reasonCode, checkedAt } };
}

describe("payroll bank check schedule", () => {
  test("newly due unresolved payroll is eligible, including uncertain queue failures", () => {
    for (const status of ["done", "failed", "needs-review"])
      expect(payrollBankCheckDue({ ...sample(), status }, since, now)).toBe(true);
  });
  test("six-hour persisted cooldown, including after recreating the request object", () => {
    const r = checked("UNKNOWN", "BANK_BATCH_NOT_FOUND");
    expect(PAYROLL_VERIFY_RETRY_MS).toBe(6 * 60 * 60_000);
    expect(payrollBankCheckDue(JSON.parse(JSON.stringify(r)), since, new Date(now.getTime() + PAYROLL_VERIFY_RETRY_MS - 1))).toBe(false);
    expect(payrollBankCheckDue(r, since, new Date(now.getTime() + PAYROLL_VERIFY_RETRY_MS))).toBe(true);
  });
  test("future payday is quiet until Bangkok midnight, even in backfill mode", () => {
    for (const mode of ["automatic", "backfill"] as const) {
      expect(payrollBankCheckDue(sample(), since, new Date(firstDue - 1), mode)).toBe(false);
      expect(payrollBankCheckDue(sample(), since, new Date(firstDue), mode)).toBe(true);
    }
  });
  test("a pre-payday scheduled status does not delay the first payday check", () => {
    const r = checked("SCHEDULED", "FUTURE_PAY_DATE", new Date(firstDue - 1).toISOString());
    expect(payrollBankCheckDue(r, since, new Date(firstDue))).toBe(true);
  });
  test("confirmed bank failure and settled payroll never repeat", () => {
    for (const mode of ["automatic", "backfill"] as const) {
      expect(payrollBankCheckDue(checked("FAILED", "BANK_FAILED"), since, now, mode)).toBe(false);
      expect(payrollBankCheckDue({ ...sample(), payrollSettlement: { status: "PAID" } }, since, now, mode)).toBe(false);
    }
  });
  test("generic failures or bare PAID labels are not bank proof", () => {
    for (const r of [checked("FAILED", "BANK_CHECK_UNAVAILABLE"), checked("PAID", "UNVERIFIED")])
      expect(payrollBankCheckDue(r, since, new Date(now.getTime() + PAYROLL_VERIFY_RETRY_MS))).toBe(true);
  });
  test("old unresolved runs stop after seven days but remain eligible for explicit backfill", () => {
    const r = checked("UNKNOWN", "BANK_BATCH_NOT_FOUND");
    const expired = new Date(firstDue + PAYROLL_VERIFY_WINDOW_MS);
    expect(PAYROLL_VERIFY_WINDOW_MS).toBe(7 * 24 * 60 * 60_000);
    expect(payrollBankCheckDue(r, since, new Date(expired.getTime() - 1))).toBe(true);
    expect(payrollBankCheckDue(r, since, expired)).toBe(false);
    expect(payrollBankCheckDue(r, since, expired, "backfill")).toBe(true);
    expect(r.payrollVerification.status).toBe("UNKNOWN");
  });
  test("new submissions with an older effective date get a window from actual start", () => {
    const startedAt = "2026-09-25T01:00:00.000Z";
    expect(payrollBankCheckDue({ ...sample(), startedAt }, since, new Date(startedAt))).toBe(true);
  });
  test("future checkedAt cannot trigger a retry storm", () => {
    expect(payrollBankCheckDue(checked("UNKNOWN", "BANK_CHECK_UNAVAILABLE", "2026-09-17T00:00:00.000Z"), since, now)).toBe(false);
  });
  test("legacy or invalid checkedAt is checked once then gets the normal persisted cooldown", () => {
    expect(payrollBankCheckDue(checked("UNKNOWN", "BANK_BATCH_NOT_FOUND", "invalid"), since, now)).toBe(true);
  });
  test("missing/invalid cutoff, clock, lifecycle or request data fails closed", () => {
    for (const cutoff of [undefined, "", "2026-09-01", "invalid", "2026-09-16T00:00:00.000Z"])
      expect(payrollBankCheckDue(sample(), cutoff, now)).toBe(false);
    expect(payrollBankCheckDue(sample(), since, new Date(NaN))).toBe(false);
    for (const patch of [
      { type: "transfer-other" }, { status: "pending" }, { status: "approved" }, { status: "running" },
      { status: "rejected" }, { startedAt: undefined }, { startedAt: "invalid" },
      { startedAt: "2026-09-14T00:00:00.000Z" }, { startedAt: "2026-09-17T00:00:00.000Z" },
      { summary: { ...sample().summary, totalAmount: 200 } },
      { summary: { ...sample().summary, effectiveDate: "31/09/2026" } },
    ]) expect(payrollBankCheckDue({ ...sample(), ...patch }, since, now, "backfill")).toBe(false);
  });
});
