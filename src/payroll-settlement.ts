import { createHash } from "node:crypto";

/** Bank proof stays in the private queue. The ledger receives only totals. */
export type PayrollSettlement = {
  source: "KBIZ_BANK_RESULT";
  status: "PAID";
  paidDate: string;
  verifiedAt: string;
  referenceNo: string;
  amountSatang: number;
  employeeCount: number;
  requestFingerprint: string;
};

export type ValidatedPayrollTransfer = {
  id: string;
  period: string;
  submittedAt: string;
  effectiveDate: string;
  amountSatang: number;
  employeeCount: number;
  // Private matching data: never return these rows from a ledger route.
  rows: { accountNumber: string; amountSatang: number }[];
};

export function payrollObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function canonicalPayrollInstant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function validPayrollDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

export function bangkokPayrollDate(now = new Date()): string {
  return new Date(now.getTime() + 7 * 60 * 60_000).toISOString().slice(0, 10);
}

/** Parse the submitted decimal value without rounding it into a different payment. */
export function payrollSatang(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid payroll amount");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error("Invalid payroll amount");
  const amount = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Invalid payroll amount");
  return amount;
}

export function validatePayrollTransfer(value: unknown): ValidatedPayrollTransfer {
  const request = payrollObject(value);
  const summary = payrollObject(request?.summary);
  if (!request || request.type !== "transfer-payroll" || !summary || summary.type !== "transfer-payroll"
    || typeof request.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(request.id)
    || !canonicalPayrollInstant(request.createdAt)
    || typeof summary.period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(summary.period)
    || typeof summary.effectiveDate !== "string" || !/^\d{2}\/\d{2}\/\d{4}$/.test(summary.effectiveDate)
    || !Array.isArray(summary.rows) || summary.rows.length < 1 || summary.rows.length > 100) {
    throw new Error("Invalid payroll request");
  }
  const [day, month, year] = summary.effectiveDate.split("/");
  const effectiveDate = `${year}-${month}-${day}`;
  if (!validPayrollDate(effectiveDate)) throw new Error("Invalid payroll date");
  const rows = summary.rows.map((value) => {
    const row = payrollObject(value);
    if (!row || typeof row.accountNumber !== "string" || !/^[\d\s-]+$/.test(row.accountNumber)) {
      throw new Error("Invalid payroll recipient");
    }
    const accountNumber = row.accountNumber.replace(/[\s-]/g, "");
    if (!/^\d{6,20}$/.test(accountNumber)) throw new Error("Invalid payroll recipient");
    return { accountNumber, amountSatang: payrollSatang(row.amount) };
  });
  const amountSatang = rows.reduce((sum, row) => sum + row.amountSatang, 0);
  if (!Number.isSafeInteger(amountSatang) || payrollSatang(summary.totalAmount) !== amountSatang) {
    throw new Error("Payroll total does not match submitted recipients");
  }
  return { id: request.id, period: summary.period, submittedAt: request.createdAt,
    effectiveDate, amountSatang, employeeCount: rows.length, rows };
}

/** Stable across row order and account-number formatting, bound to every recipient. */
export function payrollRequestFingerprint(request: unknown): string {
  const transfer = validatePayrollTransfer(request);
  const rows = transfer.rows.slice().sort((a, b) =>
    a.accountNumber.localeCompare(b.accountNumber) || a.amountSatang - b.amountSatang);
  const canonical = JSON.stringify({ id: transfer.id, period: transfer.period,
    effectiveDate: transfer.effectiveDate, rows });
  return createHash("sha256").update(canonical).digest("hex");
}

export function validatePayrollSettlement(request: unknown, now = new Date()): PayrollSettlement | null {
  const value = payrollObject(request);
  if (value?.payrollSettlement == null) return null;
  const proof = payrollObject(value.payrollSettlement);
  const transfer = validatePayrollTransfer(request);
  if (!proof || proof.source !== "KBIZ_BANK_RESULT" || proof.status !== "PAID"
    || !validPayrollDate(proof.paidDate) || proof.paidDate > bangkokPayrollDate(now)
    || !canonicalPayrollInstant(proof.verifiedAt) || proof.verifiedAt < transfer.submittedAt
    || proof.verifiedAt > now.toISOString()
    || proof.paidDate < bangkokPayrollDate(new Date(transfer.submittedAt))
    || proof.paidDate < transfer.effectiveDate
    || proof.paidDate > bangkokPayrollDate(new Date(proof.verifiedAt))
    || typeof proof.referenceNo !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _/-]{0,99}$/.test(proof.referenceNo)
    || proof.amountSatang !== transfer.amountSatang || proof.employeeCount !== transfer.employeeCount
    || proof.requestFingerprint !== payrollRequestFingerprint(request)) {
    throw new Error("Invalid payroll payment verification");
  }
  return proof as PayrollSettlement;
}

/** Small display contract shared by the HR status page and the admin queue. */
export function payrollPaymentDisplay(value: unknown, now = new Date()): {
  payrollPaidDate?: string | null;
  payrollVerificationStatus?: "PAID" | "SCHEDULED" | "PENDING" | "FAILED" | "UNKNOWN";
} {
  const request = payrollObject(value);
  if (request?.type !== "transfer-payroll") return {};
  const verification = payrollObject(request.payrollVerification);
  try {
    const proof = validatePayrollSettlement(value, now);
    const compatibleOutcome = request.status === "failed" || request.status === "needs-review"
      || (request.status === "done" && payrollObject(request.result)?.success === true);
    if (proof && compatibleOutcome && verification?.status !== "FAILED") {
      return { payrollPaidDate: proof.paidDate, payrollVerificationStatus: "PAID" };
    }
    if (proof) return { payrollPaidDate: null, payrollVerificationStatus: "UNKNOWN" };
  } catch {
    return { payrollPaidDate: null, payrollVerificationStatus: "UNKNOWN" };
  }
  const verifiedStatus = verification?.status;
  const status = verifiedStatus === "SCHEDULED" || verifiedStatus === "PENDING"
    || verifiedStatus === "FAILED" || verifiedStatus === "UNKNOWN" ? verifiedStatus
    : request.status === "done" && payrollObject(request.result)?.success === true ? "SCHEDULED"
    : request.status === "failed" || request.status === "needs-review" ? "UNKNOWN" : "PENDING";
  return { payrollPaidDate: null, payrollVerificationStatus: status };
}
