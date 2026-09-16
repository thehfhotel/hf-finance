import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPayrollBankSettlements, type PayrollBankCheckOptions } from "../src/lib/payroll-bank-check";
import { type PayrollBankBatch } from "../src/lib/payroll-bank-core";
import { conservativeLock } from "../src/lib/arm-gate";
import { readPayrollVerificationQueue } from "../src/lib/payroll-bank-files";
import { requestPayrollBackfill, readPayrollBackfillRequest, BACKFILL_REQUEST_FILE, BACKFILL_CLAIMED_FILE } from "../src/lib/payroll-bank-backfill";
import { PAYROLL_VERIFY_RETRY_MS } from "../src/lib/payroll-bank-schedule";

const now = new Date("2026-09-16T05:00:00.000Z");
const since = "2026-09-01T00:00:00.000Z";
function sample() {
  return {
    id: "sample", type: "transfer-payroll", status: "done", xlsxPath: "data/sample.xlsx",
    createdAt: "2026-09-15T00:00:00.000Z", startedAt: "2026-09-15T00:01:00.000Z",
    result: { success: true, bankReferenceNo: "PYRL000000000000001" },
    summary: { type: "transfer-payroll", period: "2026-09", effectiveDate: "16/09/2026",
      totalAmount: 100, rows: [{ accountNumber: "0000000001", amount: 100 }] },
  };
}
function historical() {
  return { ...sample(), createdAt: since, startedAt: "2026-09-04T00:01:00.000Z",
    summary: { ...sample().summary, effectiveDate: "04/09/2026" } };
}
function bank(): PayrollBankBatch {
  return { referenceNo: "PYRL000000000000001", uploadFileName: "sample.xlsx",
    status: "Success", approveStatus: "AP", createdAt: "2026-09-15T00:02:00.000Z",
    effectiveDate: "2026-09-16", executedAt: "2026-09-16T03:00:00.000Z", statusAt: "2026-09-16T03:00:00.000Z",
    amountSatang: 10000, employeeCount: 1, successCount: 1, failedCount: 0,
    recipients: [{ accountNumber: "0000000001", amountSatang: 10000, status: "Success" }] };
}
type HistoryReader = NonNullable<PayrollBankCheckOptions["readHistory"]>;
let dir: string;
let reads: number;
let readHistory: HistoryReader;
let raw: { text: string | null; mtimeMs: number | null };
let lastQuery: Parameters<HistoryReader>[0] | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sample-payroll-schedule-"));
  reads = 0;
  raw = { text: null, mtimeMs: null };
  lastQuery = undefined;
  readHistory = async () => [];
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function save(value: Record<string, unknown> = sample()) {
  await writeFile(join(dir, `${value.id}.json`), JSON.stringify(value));
}
async function saved(id = "sample") { return JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")); }
async function run(at = now) {
  await checkPayrollBankSettlements(dir, at, {
    since, readArmLock: () => raw,
    readHistory: async (q) => { reads++; lastQuery = q; return readHistory(q); },
  });
}

describe("serialized payroll bank checker without a real browser", () => {
  test("empty queue does not access the bank", async () => {
    await run();
    expect(reads).toBe(0);
  });
  test("disabled configuration does not even inspect the queue or arm lock", async () => {
    await checkPayrollBankSettlements(join(dir, "missing"), now, {
      since: "", readArmLock: () => { throw Error("must not read lock"); },
      readHistory: async () => { throw Error("must not access bank"); },
    });
  });
  test("old historical failures do not cause automatic bank sessions or get marked paid", async () => {
    const original = { ...historical(), status: "failed" };
    await save(original);
    await run();
    expect(reads).toBe(0);
    expect(await saved()).toEqual(original);
  });
  test("future payday causes no bank access or status rewriting", async () => {
    const original = { ...sample(), summary: { ...sample().summary, effectiveDate: "30/09/2026" } };
    await save(original);
    await run();
    expect(reads).toBe(0);
    expect(await saved()).toEqual(original);
  });
  test("missing result remains UNKNOWN and persists a six-hour cooldown across calls", async () => {
    await save();
    await run();
    expect(reads).toBe(1);
    expect(lastQuery?.candidateDates).toEqual(new Set(["2026-09-16"]));
    expect(lastQuery?.startDate).toBe("15/09/2026");
    expect(lastQuery?.endDate).toBe("16/09/2026");
    expect((await saved()).payrollVerification.reasonCode).toBe("BANK_BATCH_NOT_FOUND");
    await run(new Date(now.getTime() + PAYROLL_VERIFY_RETRY_MS - 1));
    expect(reads).toBe(1);
    await run(new Date(now.getTime() + PAYROLL_VERIFY_RETRY_MS));
    expect(reads).toBe(2);
    expect((await saved()).payrollSettlement).toBeUndefined();
  });
  test("bank outage also persists cooldown and never changes a payment outcome", async () => {
    await save();
    readHistory = async () => { throw Error("sample bank unavailable"); };
    await run();
    await run(new Date(now.getTime() + 15 * 60_000));
    expect(reads).toBe(1);
    const r = await saved();
    expect(r.payrollVerification.reasonCode).toBe("BANK_CHECK_UNAVAILABLE");
    expect(r.status).toBe("done");
    expect(r.result).toEqual(sample().result);
    expect(r.payrollSettlement).toBeUndefined();
  });
  test("confirmed success stops all subsequent automatic bank reads", async () => {
    await save();
    readHistory = async () => [bank()];
    await run();
    expect((await saved()).payrollSettlement.status).toBe("PAID");
    await run(new Date(now.getTime() + PAYROLL_VERIFY_RETRY_MS));
    expect(reads).toBe(1);
  });
  test("confirmed bank failure stops retries without retrying a transfer", async () => {
    await save();
    readHistory = async () => [{ ...bank(), status: "Failed", approveStatus: "RJ", successCount: 0, failedCount: 1,
      recipients: [{ accountNumber: "0000000001", amountSatang: 10000, status: "Failed" }] }];
    await run();
    expect((await saved()).payrollVerification.reasonCode).toBe("BANK_FAILED");
    await run(new Date(now.getTime() + PAYROLL_VERIFY_RETRY_MS));
    expect(reads).toBe(1);
    expect((await saved()).status).toBe("done");
    expect((await saved()).payrollSettlement).toBeUndefined();
  });
  test("stale/archived claims are retained in the exact bank ownership checks", async () => {
    await save();
    await mkdir(join(dir, "archive"));
    await writeFile(join(dir, "archive", "older.json"), JSON.stringify({ ...historical(), id: "older", xlsxPath: "data/older.xlsx" }));
    readHistory = async () => [bank()];
    await run();
    expect((await saved()).payrollVerification.reasonCode).toBe("BANK_REFERENCE_ALREADY_CLAIMED");
    expect((await saved()).payrollSettlement).toBeUndefined();
  });
  test("changed payment data during the read cannot acquire stale bank proof", async () => {
    await save();
    readHistory = async () => {
      await save({ ...sample(), summary: { ...sample().summary, totalAmount: 200,
        rows: [{ accountNumber: "0000000001", amount: 200 }] } });
      return [bank()];
    };
    await run();
    expect((await saved()).payrollSettlement).toBeUndefined();
    expect((await saved()).summary.totalAmount).toBe(200);
  });
});

describe("one-shot backfill request", () => {
  test("control files are not payment intents, and pending requests cannot be overwritten", async () => {
    await requestPayrollBackfill(dir);
    await expect(requestPayrollBackfill(dir, "sample")).rejects.toThrow();
    expect(await readPayrollVerificationQueue(dir)).toEqual([]);
    await run();
    expect(reads).toBe(0);
    expect(await readPayrollBackfillRequest(dir)).toBeNull();
    expect(await readPayrollVerificationQueue(dir)).toEqual([]);
  });
  test("historical backfill is consumed before bank access and never replays after restart", async () => {
    await save(historical());
    const request = await requestPayrollBackfill(dir, "sample");
    readHistory = async () => {
      expect(await readPayrollBackfillRequest(dir)).toBeNull();
      expect(JSON.parse(await readFile(join(dir, BACKFILL_CLAIMED_FILE), "utf8")).id).toBe(request.id);
      return [];
    };
    await run();
    await run(new Date(now.getTime() + 24 * 60 * 60_000));
    expect(reads).toBe(1);
    expect((await saved()).payrollVerification.status).toBe("UNKNOWN");
    expect((await saved()).payrollSettlement).toBeUndefined();
    await requestPayrollBackfill(dir, "sample");
    readHistory = async () => [];
    await run();
    expect(reads).toBe(2);
  });
  test("failed historical backfill is not automatically retried", async () => {
    await save(historical());
    await requestPayrollBackfill(dir);
    readHistory = async () => { throw Error("sample outage"); };
    await run();
    await run(new Date(now.getTime() + 24 * 60 * 60_000));
    expect(reads).toBe(1);
    expect(await readPayrollBackfillRequest(dir)).toBeNull();
  });
  test("backfill stays pending while payment queue work is approved/running", async () => {
    await save(historical());
    await requestPayrollBackfill(dir);
    for (const status of ["approved", "running"]) {
      await save({ id: "sample_busy", type: "list-favorites", status });
      await run();
      expect(reads).toBe(0);
      expect(await readPayrollBackfillRequest(dir)).not.toBeNull();
    }
  });
  test("live and corrupt arm locks defer backfill without consuming it", async () => {
    await save(historical());
    await requestPayrollBackfill(dir);
    for (const text of [JSON.stringify(conservativeLock("sample", now.getTime())), "invalid-json"]) {
      raw = { text, mtimeMs: now.getTime() };
      await run();
      expect(reads).toBe(0);
      expect(await readPayrollBackfillRequest(dir)).not.toBeNull();
    }
  });
  test("targeted backfill cannot accidentally verify another run", async () => {
    await save(historical());
    const other = { ...historical(), id: "sample_other" };
    await save(other);
    await requestPayrollBackfill(dir, "sample");
    await run();
    expect(reads).toBe(1);
    expect((await saved()).payrollVerification).toBeDefined();
    expect(await saved("sample_other")).toEqual(other);
  });
  test("unknown target is consumed without bank access", async () => {
    await save(historical());
    await requestPayrollBackfill(dir, "missing");
    await run();
    expect(reads).toBe(0);
    expect(await readPayrollBackfillRequest(dir)).toBeNull();
  });
  test("invalid backfill data fails closed rather than broadening scope", async () => {
    await save();
    await expect(requestPayrollBackfill(dir, "../sample")).rejects.toThrow();
    await writeFile(join(dir, BACKFILL_REQUEST_FILE), "{}");
    await expect(run()).rejects.toThrow("PAYROLL_BACKFILL_REQUEST_UNREADABLE");
    expect(reads).toBe(0);
  });
});
