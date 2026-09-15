import {
  bangkokPayrollDate,
  payrollObject,
  payrollRequestFingerprint,
  payrollSatang,
  validPayrollDate,
  validatePayrollTransfer,
  type PayrollSettlement,
  type ValidatedPayrollTransfer,
} from "../../../src/payroll-settlement";

export type PayrollVerification = {
  status: "PAID" | "SCHEDULED" | "PENDING" | "FAILED" | "UNKNOWN";
  checkedAt: string;
  reasonCode: string;
};
export type PayrollBankBatch = {
  referenceNo: string;
  status: string;
  approveStatus: string;
  createdAt: string;
  effectiveDate: string;
  executedAt: string | null;
  statusAt: string | null;
  amountSatang: number;
  employeeCount: number;
  successCount: number;
  failedCount: number;
  recipients: PayrollBankRecipient[] | null;
};
export type PayrollBankRecipient = {
  accountNumber: string;
  amountSatang: number;
  status: string;
};
export type PayrollBankDecision = {
  payrollVerification: PayrollVerification;
  payrollSettlement?: PayrollSettlement;
};
const BANK_REF = /^[A-Z]{4}\d{15}$/;
export function payrollBankReference(value: unknown): value is string {
  return typeof value === "string" && BANK_REF.test(value);
}
export function bankSatang(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value))
    throw Error("BANK_AMOUNT_INVALID");
  const [a, b = ""] = value.split(".");
  const n = Number(a) * 100 + Number(b.padEnd(2, "0"));
  if (!Number.isSafeInteger(n) || n < 0) throw Error("BANK_AMOUNT_INVALID");
  return n;
}
/** KBIZ history uses Thai-local SQL timestamps, not UTC. No locale/date guessing. */
export function bankInstant(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)
  )
    return null;
  const [date, time] = value.split(" ");
  if (!validPayrollDate(date)) return null;
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(time)!;
  if (Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3]) > 59)
    return null;
  return new Date(
    `${date}T${match[1]}:${match[2]}:${match[3]}.${(match[4] || "").padEnd(3, "0")}+07:00`,
  ).toISOString();
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw Error("BANK_COUNT_INVALID");
  return Number(value);
}
export function parsePayrollBankBatch(value: unknown): PayrollBankBatch {
  const r = payrollObject(value);
  if (
    !r ||
    r.transactionType !== "PYRL" ||
    !payrollBankReference(r.reqRefNo) ||
    typeof r.tranStatus !== "string" ||
    typeof r.approveStatus !== "string"
  )
    throw Error("BANK_BATCH_INVALID");
  const createdAt = bankInstant(r.createDate),
    effective = bankInstant(r.effectiveDate);
  if (!createdAt || !effective) throw Error("BANK_DATE_INVALID");
  return {
    referenceNo: r.reqRefNo,
    status: r.tranStatus,
    approveStatus: r.approveStatus,
    createdAt,
    effectiveDate: bangkokPayrollDate(new Date(effective)),
    executedAt: bankInstant(r.executeDate),
    statusAt: bankInstant(r.transactionStatusDate),
    amountSatang: bankSatang(r.amount),
    employeeCount: count(r.totalTransactions),
    successCount: count(r.totalSuccess),
    failedCount: count(r.totalFail),
    recipients: null,
  };
}
export function parsePayrollBankRecipient(
  value: unknown,
  referenceNo: string,
): PayrollBankRecipient {
  const r = payrollObject(value);
  if (
    !r ||
    r.reqRefNo !== referenceNo ||
    typeof r.beneficiaryNo !== "string" ||
    !/^\d{6,20}$/.test(r.beneficiaryNo) ||
    typeof r.transStatus !== "string"
  )
    throw Error("BANK_RECIPIENT_INVALID");
  return {
    accountNumber: r.beneficiaryNo,
    amountSatang:
      typeof r.amount === "number"
        ? payrollSatang(r.amount)
        : bankSatang(r.amount),
    status: r.transStatus,
  };
}
function signature(t: ValidatedPayrollTransfer): string {
  return JSON.stringify({
    date: t.effectiveDate,
    total: t.amountSatang,
    rows: t.rows
      .slice()
      .sort(
        (a, b) =>
          a.accountNumber.localeCompare(b.accountNumber) ||
          a.amountSatang - b.amountSatang,
      ),
  });
}
function bankMatches(
  t: ValidatedPayrollTransfer,
  b: PayrollBankBatch,
): boolean {
  if (
    b.effectiveDate !== t.effectiveDate ||
    b.amountSatang !== t.amountSatang ||
    b.employeeCount !== t.employeeCount ||
    !b.recipients ||
    b.recipients.length !== t.employeeCount
  )
    return false;
  const rows = b.recipients.map(({ accountNumber, amountSatang }) => ({
    accountNumber,
    amountSatang,
  }));
  return signature({ ...t, rows }) === signature(t);
}
/** All queue/archive items are required, so a bank batch can settle only one local run. */
export function decidePayrollBankVerification(
  request: unknown,
  batches: PayrollBankBatch[],
  allRequests: unknown[],
  now = new Date(),
): PayrollBankDecision {
  const decision = (
    status: PayrollVerification["status"],
    reasonCode: string,
  ): PayrollBankDecision => ({
    payrollVerification: { status, reasonCode, checkedAt: now.toISOString() },
  });
  let transfer: ValidatedPayrollTransfer;
  try {
    transfer = validatePayrollTransfer(request);
  } catch {
    return decision("UNKNOWN", "INVALID_REQUEST");
  }
  const req = payrollObject(request)!;
  const result = payrollObject(req.result);
  const captured = payrollBankReference(result?.bankReferenceNo)
    ? (result!.bankReferenceNo as string)
    : null;
  if (transfer.effectiveDate > bangkokPayrollDate(now))
    return decision("SCHEDULED", "FUTURE_PAY_DATE");
  const candidates = batches.filter((b) =>
    captured
      ? b.referenceNo === captured
      : bankMatches(transfer, b) && b.createdAt >= transfer.submittedAt,
  );
  if (candidates.length !== 1)
    return decision(
      "UNKNOWN",
      candidates.length ? "AMBIGUOUS_BANK_BATCH" : "BANK_BATCH_NOT_FOUND",
    );
  const bank = candidates[0];
  for (const other of allRequests) {
    const r = payrollObject(other);
    if (!r || r.id === transfer.id || r.type !== "transfer-payroll") continue;
    if (
      String(payrollObject(r.payrollSettlement)?.referenceNo || "")
        .replace(/\s/g, "")
        .toUpperCase() === bank.referenceNo ||
      String(payrollObject(r.result)?.bankReferenceNo || "")
        .replace(/\s/g, "")
        .toUpperCase() === bank.referenceNo
    )
      return decision("UNKNOWN", "BANK_REFERENCE_ALREADY_CLAIMED");
    if (!captured && !["rejected", "pending"].includes(String(r.status))) {
      try {
        if (signature(validatePayrollTransfer(other)) === signature(transfer))
          return decision("UNKNOWN", "AMBIGUOUS_LOCAL_RUN");
      } catch {
        return decision("UNKNOWN", "INVALID_OTHER_REQUEST");
      }
    }
  }
  if (!bankMatches(transfer, bank))
    return decision("UNKNOWN", "BANK_RECIPIENT_MISMATCH");
  if (bank.createdAt < transfer.submittedAt)
    return decision("UNKNOWN", "BANK_BATCH_PREDATES_REQUEST");
  if (bank.status === "Scheduled")
    return decision("SCHEDULED", "BANK_SCHEDULED");
  if (
    ["In Process", "In Process Ack", "In Process Debit"].includes(bank.status)
  )
    return decision("PENDING", "BANK_PROCESSING");
  if (
    ["Failed", "Fail", "Failed Refund", "Rejected", "rejected"].includes(
      bank.status,
    ) ||
    bank.approveStatus === "RJ"
  )
    return decision("FAILED", "BANK_FAILED");
  if (
    bank.status !== "Success" ||
    bank.approveStatus !== "AP" ||
    bank.successCount !== transfer.employeeCount ||
    bank.failedCount !== 0 ||
    !bank.recipients?.every((r) => r.status === "Success")
  )
    return decision("UNKNOWN", "BANK_NOT_ALL_SUCCESS");
  if (
    !bank.executedAt ||
    bank.executedAt !== bank.statusAt ||
    bank.executedAt > now.toISOString() ||
    bank.executedAt < transfer.submittedAt
  )
    return decision("UNKNOWN", "BANK_EXECUTION_DATE_UNVERIFIED");
  const paidDate = bangkokPayrollDate(new Date(bank.executedAt));
  if (paidDate < transfer.effectiveDate)
    return decision("UNKNOWN", "BANK_EXECUTION_BEFORE_PAY_DATE");
  return {
    ...decision("PAID", "BANK_ALL_RECIPIENTS_SUCCESS"),
    payrollSettlement: {
      source: "KBIZ_BANK_RESULT",
      status: "PAID",
      paidDate,
      verifiedAt: now.toISOString(),
      referenceNo: bank.referenceNo,
      amountSatang: transfer.amountSatang,
      employeeCount: transfer.employeeCount,
      requestFingerprint: payrollRequestFingerprint(request),
    },
  };
}

export function collectPayrollBankPage(
  data: Record<string, unknown>,
  field: string,
  soFar: unknown[],
  expected: number | null,
): { total: number; items: unknown[] } {
  const rows = data[field],
    total = data.totalList;
  if (
    !Number.isSafeInteger(total) ||
    Number(total) < 0 ||
    Number(total) > 2000 ||
    !Array.isArray(rows) ||
    rows.length > 100 ||
    (expected !== null && total !== expected) ||
    soFar.length + rows.length > Number(total) ||
    (rows.length === 0 && soFar.length < Number(total))
  )
    throw Error("BANK_HISTORY_INCOMPLETE");
  return { total: Number(total), items: [...soFar, ...rows] };
}
