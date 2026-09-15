import { describe, expect, test } from "bun:test";
import {
  bankInstant,
  bankSatang,
  decidePayrollBankVerification,
  parsePayrollBankBatch,
  parsePayrollBankRecipient,
  type PayrollBankBatch,
} from "../src/lib/payroll-bank-core";
const now = new Date("2026-09-15T10:00:00.000Z");
const ref = "PYRL000000000000001";
function request(id = "sample_run") {
  return {
    id,
    type: "transfer-payroll",
    createdAt: "2026-09-01T08:00:00.000Z",
    status: "done",
    result: { success: true, bankReferenceNo: ref },
    summary: {
      type: "transfer-payroll",
      period: "2026-09",
      effectiveDate: "15/09/2026",
      totalAmount: 300,
      rows: [
        { accountNumber: "0000000001", amount: 100 },
        { accountNumber: "0000000002", amount: 200 },
      ],
    },
  };
}
function batch(): PayrollBankBatch {
  return {
    referenceNo: ref,
    status: "Success",
    approveStatus: "AP",
    createdAt: "2026-09-01T08:01:00.000Z",
    effectiveDate: "2026-09-15",
    executedAt: "2026-09-15T02:00:00.000Z",
    statusAt: "2026-09-15T02:00:00.000Z",
    amountSatang: 30000,
    employeeCount: 2,
    successCount: 2,
    failedCount: 0,
    recipients: [
      { accountNumber: "0000000001", amountSatang: 10000, status: "Success" },
      { accountNumber: "0000000002", amountSatang: 20000, status: "Success" },
    ],
  };
}
function check(b = batch(), r: unknown = request(), others: unknown[] = []) {
  return decidePayrollBankVerification(r, [b], [r, ...others], now);
}
describe("bank payroll proof", () => {
  test("paid requires matching every beneficiary and actual bank execution", () => {
    const proof = check().payrollSettlement!;
    expect(proof.status).toBe("PAID");
    expect(proof.paidDate).toBe("2026-09-15");
    expect(proof.amountSatang).toBe(30000);
    expect(proof.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  test("URL completion or a reference alone is never payment evidence", () => {
    expect(
      decidePayrollBankVerification(request(), [], [request()], now)
        .payrollSettlement,
    ).toBeUndefined();
  });
  test.each([
    "Scheduled",
    "In Process",
    "In Process Ack",
    "Failed",
    "Failed Refund",
    "rejected",
    "unexpected",
  ])("%s stays unpaid", (status) => {
    expect(check({ ...batch(), status }).payrollSettlement).toBeUndefined();
  });
  test("each count and beneficiary success is required", () => {
    for (const b of [
      { ...batch(), successCount: 1 },
      { ...batch(), failedCount: 1 },
      { ...batch(), employeeCount: 3 },
      { ...batch(), recipients: batch().recipients!.slice(1) },
      {
        ...batch(),
        recipients: batch().recipients!.map((r) => ({
          ...r,
          status: "In Process",
        })),
      },
    ])
      expect(check(b).payrollSettlement).toBeUndefined();
  });
  test("same total and last digits with wrong full account cannot match", () => {
    const b = batch();
    b.recipients![0].accountNumber = "9999990001";
    expect(check(b).payrollSettlement).toBeUndefined();
  });
  test("same total with changed beneficiary allocation cannot match", () => {
    const b = batch();
    b.recipients![0].amountSatang = 20000;
    b.recipients![1].amountSatang = 10000;
    expect(check(b).payrollSettlement).toBeUndefined();
  });
  test("bank duplicate beneficiary cannot replace a missing recipient", () => {
    const b = batch();
    b.recipients![1] = { ...b.recipients![0] };
    expect(check(b).payrollSettlement).toBeUndefined();
  });
  test("full bank reference is globally claimed even in historical or lowercase proof", () => {
    for (const other of [
      {
        ...request("old_run"),
        payrollSettlement: { referenceNo: ref.toLowerCase() },
      },
      request("old_run"),
    ])
      expect(
        check(batch(), request(), [other]).payrollVerification.reasonCode,
      ).toBe("BANK_REFERENCE_ALREADY_CLAIMED");
  });
  test("legacy no-reference exact match requires unique bank and local runs", () => {
    const r = { ...request(), result: { success: true } };
    expect(check(batch(), r).payrollSettlement?.status).toBe("PAID");
    expect(
      decidePayrollBankVerification(
        r,
        [batch(), { ...batch(), referenceNo: "PYRL000000000000002" }],
        [r],
        now,
      ).payrollVerification.reasonCode,
    ).toBe("AMBIGUOUS_BANK_BATCH");
    const other = { ...request("other"), result: { success: true } };
    expect(check(batch(), r, [other]).payrollVerification.reasonCode).toBe(
      "AMBIGUOUS_LOCAL_RUN",
    );
  });
  test("known reference matches only the exact bank batch", () => {
    expect(
      check({ ...batch(), referenceNo: "PYRL000000000000002" })
        .payrollSettlement,
    ).toBeUndefined();
  });
  test("wrong effective date, creation before submission, missing/future status or execution cannot settle", () => {
    for (const b of [
      { ...batch(), effectiveDate: "2026-09-14" },
      { ...batch(), createdAt: "2026-08-01T00:00:00.000Z" },
      { ...batch(), executedAt: null },
      { ...batch(), statusAt: null },
      {
        ...batch(),
        executedAt: "2026-09-16T00:00:00.000Z",
        statusAt: "2026-09-16T00:00:00.000Z",
      },
      {
        ...batch(),
        executedAt: "2026-09-14T00:00:00.000Z",
        statusAt: "2026-09-14T00:00:00.000Z",
      },
    ])
      expect(check(b).payrollSettlement).toBeUndefined();
  });
  test("future payday needs no bank lookup and cannot be paid", () => {
    const r = request();
    r.summary.effectiveDate = "16/09/2026";
    expect(check(batch(), r).payrollVerification.status).toBe("SCHEDULED");
  });
  test("actual bank proof can resolve a prior URL timeout", () => {
    expect(
      check(batch(), {
        ...request(),
        status: "failed",
        result: { success: false, bankReferenceNo: ref },
      }).payrollSettlement?.status,
    ).toBe("PAID");
  });
});
describe("observed bank schema", () => {
  test("Thai-local timestamp uses Bangkok timezone, supports observed fractional precision", () => {
    expect(bankInstant("2026-09-15 09:30:00.1")).toBe(
      "2026-09-15T02:30:00.100Z",
    );
    expect(bankInstant("2026-02-30 09:30:00.0")).toBeNull();
    expect(bankInstant("2026-09-15 25:00:00.0")).toBeNull();
    expect(bankInstant("15/09/2026")).toBeNull();
  });
  test("bank decimal amount does not round extra precision", () => {
    expect(bankSatang("300.10")).toBe(30010);
    expect(() => bankSatang("300.001")).toThrow();
    expect(() => bankSatang("NaN")).toThrow();
  });
  test("beneficiary detail amount is numeric and full account is required", () => {
    expect(
      parsePayrollBankRecipient(
        {
          reqRefNo: ref,
          beneficiaryNo: "0000000001",
          amount: 100.25,
          transStatus: "Success",
        },
        ref,
      ).amountSatang,
    ).toBe(10025);
    expect(() =>
      parsePayrollBankRecipient(
        {
          reqRefNo: ref,
          beneficiaryNo: "XXXXXX0001",
          amount: 100,
          transStatus: "Success",
        },
        ref,
      ),
    ).toThrow();
    expect(() =>
      parsePayrollBankRecipient(
        {
          reqRefNo: "PYRL000000000000002",
          beneficiaryNo: "0000000001",
          amount: 100,
          transStatus: "Success",
        },
        ref,
      ),
    ).toThrow();
  });
  test("history parses only payroll and validates count types", () => {
    const raw = {
      transactionType: "PYRL",
      reqRefNo: ref,
      tranStatus: "Success",
      approveStatus: "AP",
      createDate: "2026-09-01 15:01:00.0",
      effectiveDate: "2026-09-15 00:00:00.0",
      executeDate: "2026-09-15 09:00:00.0",
      transactionStatusDate: "2026-09-15 09:00:00.0",
      amount: "300.00",
      totalTransactions: 2,
      totalSuccess: 2,
      totalFail: 0,
    };
    expect(parsePayrollBankBatch(raw).amountSatang).toBe(30000);
    expect(() =>
      parsePayrollBankBatch({ ...raw, totalSuccess: "2" }),
    ).toThrow();
    expect(() =>
      parsePayrollBankBatch({ ...raw, transactionType: "OTHER" }),
    ).toThrow();
  });
});
