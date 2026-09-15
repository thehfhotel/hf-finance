import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPayrollVerificationQueue,
  patchPayrollVerification,
} from "../src/lib/payroll-bank-files";
import { collectPayrollBankPage } from "../src/lib/payroll-bank-core";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sample-payroll-bank-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const request = () => ({
  id: "sample",
  type: "transfer-payroll",
  status: "done",
  createdAt: "2026-09-01T00:00:00.000Z",
  result: { success: true },
  summary: {
    type: "transfer-payroll",
    period: "2026-09",
    effectiveDate: "15/09/2026",
    totalAmount: 100,
    rows: [{ accountNumber: "0000000001", amount: 100 }],
  },
});
describe("private queue proof updates", () => {
  test("global scan includes archived claims and skips only known manifests", async () => {
    await mkdir(join(dir, "archive"));
    await writeFile(join(dir, "sample.json"), JSON.stringify(request()));
    await writeFile(
      join(dir, "archive", "older.json"),
      JSON.stringify({
        ...request(),
        id: "older",
        status: "running",
        payrollSettlement: { referenceNo: "PYRL000000000000001" },
      }),
    );
    await writeFile(join(dir, "payee-handles.json"), "{}");
    const records = await readPayrollVerificationQueue(dir);
    expect(records).toHaveLength(2);
    expect(records.filter((r) => r.archived)).toHaveLength(1);
  });
  test("malformed valid JSON, unknown types, duplicate IDs cannot disappear from global claim scan", async () => {
    for (const malformed of [
      {},
      { id: "x", status: "done" },
      { id: "x", type: "new-payment-type", status: "done" },
    ]) {
      await writeFile(join(dir, "unknown.json"), JSON.stringify(malformed));
      await expect(readPayrollVerificationQueue(dir)).rejects.toThrow();
    }
    await rm(join(dir, "unknown.json"));
    await writeFile(join(dir, "one.json"), JSON.stringify(request()));
    await writeFile(join(dir, "two.json"), JSON.stringify(request()));
    await expect(readPayrollVerificationQueue(dir)).rejects.toThrow(
      "PAYROLL_QUEUE_DUPLICATE_ID",
    );
  });
  test("proof metadata preserves original submit result and unrelated audit fields", async () => {
    const file = join(dir, "sample.json"),
      value = { ...request(), approvedBy: "SAMPLE_ADMIN" };
    await writeFile(file, JSON.stringify(value));
    await patchPayrollVerification(
      { file, value },
      {
        payrollVerification: { status: "PAID" },
        payrollSettlement: { referenceNo: "PYRL000000000000001" },
      },
    );
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.result).toEqual(value.result);
    expect(saved.status).toBe("done");
    expect(saved.approvedBy).toBe("SAMPLE_ADMIN");
    expect(saved.payrollSettlement.referenceNo).toBe("PYRL000000000000001");
  });
  test("changed payment rows or request lifecycle are never overwritten by stale verification", async () => {
    const file = join(dir, "sample.json"),
      original = request();
    for (const current of [
      { ...original, status: "approved" },
      {
        ...original,
        summary: {
          ...original.summary,
          totalAmount: 200,
          rows: [{ accountNumber: "0000000001", amount: 200 }],
        },
      },
    ]) {
      await writeFile(file, JSON.stringify(current));
      await patchPayrollVerification(
        { file, value: original },
        { payrollSettlement: { referenceNo: "PYRL000000000000001" } },
      );
      expect(
        JSON.parse(await readFile(file, "utf8")).payrollSettlement,
      ).toBeUndefined();
    }
  });
  test("already-persisted proof is retained on a later stale check", async () => {
    const file = join(dir, "sample.json"),
      original = request();
    const proof = { referenceNo: "PYRL000000000000001" };
    await writeFile(
      file,
      JSON.stringify({ ...original, payrollSettlement: proof }),
    );
    await patchPayrollVerification(
      { file, value: original },
      { payrollVerification: { status: "UNKNOWN" } },
    );
    expect(JSON.parse(await readFile(file, "utf8")).payrollSettlement).toEqual(
      proof,
    );
    expect(
      JSON.parse(await readFile(file, "utf8")).payrollVerification,
    ).toBeUndefined();
  });
});
describe("bank complete pagination", () => {
  test("collects multiple pages with consistent total", () => {
    const first = collectPayrollBankPage(
      { totalList: 3, inquiryModelList: [1, 2] },
      "inquiryModelList",
      [],
      null,
    );
    const last = collectPayrollBankPage(
      { totalList: 3, inquiryModelList: [3] },
      "inquiryModelList",
      first.items,
      first.total,
    );
    expect(last.items).toEqual([1, 2, 3]);
    expect(last.items.length).toBe(last.total);
  });
  test("incomplete empty page, count change, overflow, malformed and bounded responses fail closed", () => {
    for (const data of [
      { totalList: 3, inquiryModelList: [] },
      { totalList: 4, inquiryModelList: [3] },
      { totalList: 3, inquiryModelList: [3, 4] },
      { totalList: 3, inquiryModelList: {} },
      { totalList: 2001, inquiryModelList: [3] },
      { totalList: "3", inquiryModelList: [3] },
    ])
      expect(() =>
        collectPayrollBankPage(data, "inquiryModelList", [1, 2], 3),
      ).toThrow();
  });
});
