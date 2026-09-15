import type { Page, Response } from "playwright";
import { gotoAuthenticated } from "./session";
import {
  collectPayrollBankPage,
  parsePayrollBankBatch,
  parsePayrollBankRecipient,
  type PayrollBankBatch,
} from "./payroll-bank-core";
import { payrollObject } from "../../../src/payroll-settlement";

const HISTORY = "https://kbiz.kasikornbank.com/menu/account/account/history";
const API = "https://kbiz.kasikornbank.com/services/api/transactioninquiry/";
type ReadMethod = "getTransactionHistoryMaker" | "getPayrollDetailTransaction";

/** Read requests only. Credentials remain in the one bank browser; no API token is published. */
async function readBank(
  page: Page,
  method: ReadMethod,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    method !== "getTransactionHistoryMaker" &&
    method !== "getPayrollDetailTransaction"
  )
    throw Error("BANK_READ_METHOD_INVALID");
  const response = await page.evaluate(
    async ({ url, headers, body }) => {
      const token = localStorage.getItem("ssoSessionId");
      if (!token) throw Error("BANK_SESSION_MISSING");
      const h = {
        ...headers,
        authorization: token,
        "content-type": "application/json",
        "x-re-fresh": "N",
        "x-request-id":
          new Date().toISOString().replace(/\D/g, "") +
          String(Math.floor(Math.random() * 900) + 100),
      };
      const r = await fetch(url, {
        method: "POST",
        headers: h,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const refreshed = r.headers.get("x-session-token");
      if (refreshed) localStorage.setItem("ssoSessionId", refreshed);
      if (!r.ok) throw Error("BANK_READ_HTTP_" + r.status);
      return await r.json();
    },
    { url: API + method, headers, body },
  );
  const envelope = payrollObject(response),
    data = payrollObject(envelope?.data);
  if (envelope?.status !== "S" || !data)
    throw Error("BANK_READ_INVALID_RESPONSE");
  return data;
}
/**
 * Public bank frontend + live schema verified 2026-09-15. Complete pagination is
 * mandatory; beneficiaryNo stays private, never fall back to masked last-four.
 * Uses the same Page sequentially in process-queue, never an independent login.
 */
export async function readPayrollBankHistory(
  page: Page,
  options: { startDate: string; endDate: string; candidateDates: Set<string> },
): Promise<PayrollBankBatch[]> {
  let seed: Response | undefined;
  const observe = (r: Response) => {
    if (
      r.url() === API + "getTransactionHistoryMaker" &&
      r.request().method() === "POST"
    )
      seed = r;
  };
  page.on("response", observe);
  try {
    await gotoAuthenticated(page, HISTORY);
    await page
      .locator("#tranType")
      .waitFor({ state: "attached", timeout: 30_000 });
    if (!seed) {
      await page.waitForResponse(
        (r) => r.url() === API + "getTransactionHistoryMaker",
        { timeout: 30_000 },
      );
    }
    if (!seed) throw Error("BANK_HISTORY_REQUEST_MISSING");
    const request = seed.request();
    const captured = await request.allHeaders();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(captured))
      if (k.startsWith("x-") || k === "accept") headers[k] = v;
    const original = payrollObject(request.postDataJSON());
    if (!original) throw Error("BANK_HISTORY_REQUEST_INVALID");
    const base = {
      ...original,
      tranType: "PYRL",
      startDate: options.startDate,
      endDate: options.endDate,
      approveStatusList: [],
      transStatus: [],
      accountTo: null,
      bankCode: null,
      pageAmount: 100,
    };
    let rows: unknown[] = [],
      total: number | null = null;
    for (let pageNumber = 1; pageNumber <= 20; pageNumber++) {
      const data = await readBank(page, "getTransactionHistoryMaker", headers, {
        ...base,
        pageNumber,
      });
      const next = collectPayrollBankPage(
        data,
        "inquiryModelList",
        rows,
        total,
      );
      rows = next.items;
      total = next.total;
      if (rows.length === total) break;
    }
    if (total === null || rows.length !== total)
      throw Error("BANK_HISTORY_INCOMPLETE");
    const batches = rows.map(parsePayrollBankBatch);
    if (new Set(batches.map((b) => b.referenceNo)).size !== batches.length)
      throw Error("BANK_HISTORY_DUPLICATE_REFERENCE");
    for (const batch of batches) {
      if (!options.candidateDates.has(batch.effectiveDate)) continue;
      let recipients: unknown[] = [],
        count: number | null = null;
      for (let pageNumber = 1; pageNumber <= 2; pageNumber++) {
        const data = await readBank(
          page,
          "getPayrollDetailTransaction",
          headers,
          {
            reqRefNo: batch.referenceNo,
            pageNumber,
            pageAmount: 100,
            language: "th",
          },
        );
        const next = collectPayrollBankPage(
          data,
          "payrollDetailList",
          recipients,
          count,
        );
        recipients = next.items;
        count = next.total;
        if (recipients.length === count) break;
      }
      if (
        count === null ||
        count !== batch.employeeCount ||
        recipients.length !== count
      )
        throw Error("BANK_RECIPIENTS_INCOMPLETE");
      batch.recipients = recipients.map((r) =>
        parsePayrollBankRecipient(r, batch.referenceNo),
      );
    }
    return batches;
  } finally {
    page.off("response", observe);
  }
}
