import { afterAll, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPayrollLedgerFeed, readPayrollLedgerSnapshot } from "../src/ledger-feed";
import { payrollPaymentDisplay, payrollRequestFingerprint, payrollSatang, validatePayrollTransfer } from "../src/payroll-settlement";

const SINCE = "2026-09-15T09:45:09.165Z";
const CREATED = "2026-09-16T04:00:00.000Z";
const NOW = new Date("2026-10-05T06:00:00.000Z");
const TOKEN = "test-payroll-service-token";
const temporaryDirs: string[] = [];
const fixture = (id = "20260916040000-sample") => ({
  id, type: "transfer-payroll", status: "pending", createdAt: CREATED,
  updatedAt: CREATED, xlsxPath: `private/${id}.xlsx`,
  summary: {
    type: "transfer-payroll", period: "2026-09", effectiveDate: "05/10/2026", totalAmount: 345.67,
    rows: [
      { accountNumber: "111-1-11111-1", accountName: "ทดสอบ หนึ่ง", amount: 123.45 },
      { accountNumber: "2222222222", accountName: "ทดสอบ สอง", amount: 222.22 },
    ],
    sheet: { rows: [{ salary: 999, note: "PRIVATE SAMPLE NOTE" }] },
  },
});

const paidFixture = () => {
  const request = { ...fixture(), status: "done", result: { success: true, finalUrl: "https://bank.invalid/submitted" } };
  return { ...request, payrollSettlement: {
    source: "KBIZ_BANK_RESULT", status: "PAID", paidDate: "2026-10-05",
    verifiedAt: "2026-10-05T05:00:00.000Z", referenceNo: "SAMPLE-REFERENCE-1",
    amountSatang: 34567, employeeCount: 2, requestFingerprint: payrollRequestFingerprint(request),
  } };
};

async function queue(records: unknown[] = []) {
  const queueDir = await mkdtemp(join(tmpdir(), "payroll-ledger-feed-"));
  temporaryDirs.push(queueDir);
  for (const [index, record] of records.entries()) {
    const name = (record as { id?: string })?.id ?? `unknown-${index}`;
    await writeFile(join(queueDir, `${name}.json`), JSON.stringify(record));
  }
  return queueDir;
}

async function response(queueDir: string, options: { token?: string; auth?: string; since?: string } = {}) {
  const app = new Elysia().use(createPayrollLedgerFeed({ queueDir,
    token: () => options.token ?? TOKEN, now: () => NOW }));
  return app.handle(new Request(`http://localhost/api/ledger-feed/payroll?since=${encodeURIComponent(options.since ?? SINCE)}`, {
    headers: { authorization: options.auth ?? `Bearer ${TOKEN}` },
  }));
}

afterAll(async () => { await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("payroll ledger feed", () => {
  it("requires its own service token even when the queue is empty", async () => {
    const dir = await queue();
    for (const auth of ["", "Bearer wrong", TOKEN, "Bearer reimbursement-service-token"]) {
      const denied = await response(dir, { auth });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("cache-control")).toBe("no-store");
    }
    expect((await response(dir, { token: "" })).status).toBe(401);
  });

  it("validates the canonical UTC cutoff", async () => {
    const dir = await queue();
    for (const since of ["", "2026-09-15", "2026-09-15T09:45:09Z", "2026-02-30T00:00:00.000Z", "2026-09-15T16:45:09.165+07:00"]) {
      expect((await response(dir, { since })).status).toBe(400);
    }
  });

  it("returns one aggregate net row and exposes no employee or bank data", async () => {
    const dir = await queue([fixture()]);
    const res = await response(dir);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ version: 1, complete: true, since: SINCE, generatedAt: NOW.toISOString(), items: [{
      id: fixture().id, period: "2026-09", submittedAt: CREATED, effectiveDate: "2026-10-05",
      amountSatang: 34567, employeeCount: 2, status: "PENDING", paidDate: null,
    }] });
    const serialized = JSON.stringify(body);
    for (const privateValue of ["ทดสอบ", "1111111111", "123.45", "PRIVATE", "xlsxPath", "accountNumber", "salary", "referenceNo"]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it("only includes new payroll submissions while tolerating known other queue owners", async () => {
    const dir = await queue([
      { ...fixture("older"), createdAt: "2026-09-15T09:45:09.164Z", summary: {} },
      { ...fixture("boundary"), createdAt: SINCE },
      { id: "other-app", app: "reimbursement", type: "transfer-other", createdAt: CREATED },
      { id: "roster", type: "add-payroll" }, { id: "roster-sync", type: "list-registered" },
    ]);
    await writeFile(join(dir, "payee-handles.json"), "not a payroll request");
    await writeFile(join(dir, "kbiz-favorites.json"), "not a payroll request");
    const snapshot = await readPayrollLedgerSnapshot(SINCE, { queueDir: dir, now: NOW });
    expect(snapshot.items.map((row) => row.id)).toEqual(["boundary"]);
  });

  it("preserves source outcomes, and never infers payment from approval or a passed pay date", async () => {
    const values = ["pending", "approved", "running", "done", "rejected", "failed", "needs-review"];
    const dir = await queue(values.map((status) => ({ ...fixture(status), status, result: { success: status === "done" } })));
    const snapshot = await readPayrollLedgerSnapshot(SINCE, { queueDir: dir, now: new Date("2027-01-01T00:00:00.000Z") });
    expect(Object.fromEntries(snapshot.items.map((row) => [row.id, row.status]))).toEqual({
      pending: "PENDING", approved: "APPROVED", running: "APPROVED", done: "SCHEDULED", rejected: "REJECTED", failed: "FAILED",
      "needs-review": "FAILED",
    });
    expect(snapshot.items.every((row) => row.paidDate === null)).toBe(true);
  });

  it("marks paid only with bank proof matching the submitted recipients and net total", async () => {
    const dir = await queue([paidFixture()]);
    const snapshot = await readPayrollLedgerSnapshot(SINCE, { queueDir: dir, now: NOW });
    expect(snapshot.items[0].status).toBe("PAID");
    expect(snapshot.items[0].paidDate).toBe("2026-10-05");
    expect(JSON.stringify(snapshot)).not.toContain("SAMPLE-REFERENCE");
    expect(JSON.stringify(snapshot)).not.toContain("requestFingerprint");
  });

  it("rejects a stale or mismatched paid proof without emitting a partial snapshot", async () => {
    for (const change of [
      { amountSatang: 34568 }, { employeeCount: 1 }, { requestFingerprint: "0".repeat(64) },
      { paidDate: "2026-10-06" }, { paidDate: "2026-02-30" }, { verifiedAt: "2026-10-05T06:00:01.000Z" },
      { verifiedAt: "2026-01-01T00:00:00.000Z" }, { referenceNo: "" }, { source: "MANUAL" },
      { paidDate: "2026-09-15" }, { paidDate: "2026-10-04" }, { verifiedAt: "2026-10-04T05:00:00.000Z" },
    ]) {
      const request = paidFixture();
      request.payrollSettlement = { ...request.payrollSettlement, ...change };
      const res = await response(await queue([fixture("valid"), request]));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "payroll snapshot unavailable" });
    }
  });

  it("never exports the same bank payment as paid under two submitted requests", async () => {
    const first = paidFixture();
    const second = { ...paidFixture(), id: "second-request" };
    second.payrollSettlement.requestFingerprint = payrollRequestFingerprint(second);
    second.payrollSettlement.referenceNo = first.payrollSettlement.referenceNo.toLowerCase();
    expect((await response(await queue([first, second]))).status).toBe(503);
    first.createdAt = "2026-09-14T00:00:00.000Z";
    first.payrollSettlement.requestFingerprint = payrollRequestFingerprint(first);
    expect((await response(await queue([first, second]))).status).toBe(503);
  });

  it("reports confirmed bank failure and refuses contradictory paid proof", async () => {
    const verification = { status: "FAILED", checkedAt: NOW.toISOString(), reasonCode: "BANK_REJECTED" };
    const failed = { ...fixture(), status: "done", result: { success: true }, payrollVerification: verification };
    const snapshot = await readPayrollLedgerSnapshot(SINCE, { queueDir: await queue([failed]), now: NOW });
    expect(snapshot.items[0].status).toBe("FAILED");
    expect((await response(await queue([{ ...paidFixture(), payrollVerification: verification }]))).status).toBe(503);
  });

  it("accepts actual bank payment proof after a failed browser attempt without rewriting that attempt", async () => {
    const request = { ...paidFixture(), status: "failed", result: { success: false, error: "Browser confirmation timed out" } };
    const snapshot = await readPayrollLedgerSnapshot(SINCE, { queueDir: await queue([request]), now: NOW });
    expect(snapshot.items[0].status).toBe("PAID");
    expect(request.status).toBe("failed");
    expect(payrollPaymentDisplay(request, NOW)).toEqual({ payrollPaidDate: "2026-10-05", payrollVerificationStatus: "PAID" });
    expect((await response(await queue([{ ...request, status: "pending" }]))).status).toBe(503);
    const needsReview = await readPayrollLedgerSnapshot(SINCE, { queueDir: await queue([{ ...request, status: "needs-review" }]), now: NOW });
    expect(needsReview.items[0].status).toBe("PAID");
  });

  it("fails closed on malformed, missing or incomplete queue data and sanitizes errors", async () => {
    const dir = await queue([fixture()]);
    await writeFile(join(dir, "broken.json"), '{"private":"PRIVATE SAMPLE NAME"');
    const invalid = await response(dir);
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toEqual({ error: "payroll snapshot unavailable" });
    expect((await response(join(dir, "missing"))).status).toBe(503);
    for (const change of [{ summary: {} }, { status: "unknown" }, { status: "done", result: { success: false } }, { createdAt: "invalid" }]) {
      expect((await response(await queue([{ ...fixture(), ...change }]))).status).toBe(503);
    }
  });

  it("rejects amount mismatch, fractional satang, impossible dates, and queue identity mismatch", async () => {
    for (const summaryPatch of [{ totalAmount: 345.68 }, { effectiveDate: "31/02/2026" }, { period: "" },
      { rows: [{ accountNumber: "1111111111", accountName: "ทดสอบ", amount: 0.001 }] }]) {
      const request = fixture();
      request.summary = { ...request.summary, ...summaryPatch };
      expect((await response(await queue([request]))).status).toBe(503);
    }
    const dir = await queue();
    await writeFile(join(dir, "wrong-id.json"), JSON.stringify(fixture()));
    expect((await response(dir)).status).toBe(503);
  });
});

describe("payroll settlement matching", () => {
  it("fingerprints the exact immutable batch while ignoring row order and account formatting", () => {
    const original = fixture();
    const same = fixture();
    same.summary.rows.reverse();
    same.summary.rows[1].accountNumber = "1111111111";
    expect(payrollRequestFingerprint(same)).toBe(payrollRequestFingerprint(original));
    same.summary.rows[1].accountNumber = "3333333333";
    expect(payrollRequestFingerprint(same)).not.toBe(payrollRequestFingerprint(original));
    expect(payrollRequestFingerprint({ ...original, id: "different-request" })).not.toBe(payrollRequestFingerprint(original));
    expect(validatePayrollTransfer(original).amountSatang).toBe(34567);
  });

  it("requires safe exact positive satang values", () => {
    expect(payrollSatang(123.45)).toBe(12345);
    expect(payrollSatang(0.01)).toBe(1);
    for (const invalid of [0, -1, 0.001, Infinity, NaN, Number.MAX_SAFE_INTEGER, "123.45"]) {
      expect(() => payrollSatang(invalid)).toThrow();
    }
  });

  it("returns a safe status summary for UI and hides invalid payment proof", () => {
    expect(payrollPaymentDisplay(paidFixture(), NOW)).toEqual({ payrollPaidDate: "2026-10-05", payrollVerificationStatus: "PAID" });
    expect(payrollPaymentDisplay({ ...fixture(), status: "done", result: { success: true } }, NOW))
      .toEqual({ payrollPaidDate: null, payrollVerificationStatus: "SCHEDULED" });
    const invalid = paidFixture();
    invalid.payrollSettlement.amountSatang += 1;
    expect(payrollPaymentDisplay(invalid, NOW)).toEqual({ payrollPaidDate: null, payrollVerificationStatus: "UNKNOWN" });
    expect(payrollPaymentDisplay({ type: "add-payroll" }, NOW)).toEqual({});
  });
});
