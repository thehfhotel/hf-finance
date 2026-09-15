import { Elysia } from "elysia";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalPayrollInstant, payrollObject, validatePayrollSettlement, validatePayrollTransfer } from "./payroll-settlement";

export type PayrollLedgerItem = {
  id: string;
  period: string;
  submittedAt: string;
  effectiveDate: string;
  amountSatang: number;
  employeeCount: number;
  status: "PENDING" | "APPROVED" | "SCHEDULED" | "PAID" | "REJECTED" | "FAILED";
  paidDate: string | null;
};

export function payrollLedgerAuthorized(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

function ledgerItem(value: unknown, now: Date): PayrollLedgerItem {
  const request = payrollObject(value)!;
  const transfer = validatePayrollTransfer(value);
  const result = payrollObject(request.result);
  const verification = payrollObject(request.payrollVerification);
  let status: PayrollLedgerItem["status"];
  switch (request.status) {
    case "pending": status = "PENDING"; break;
    case "approved": case "running": status = "APPROVED"; break;
    case "rejected": status = "REJECTED"; break;
    case "failed": case "needs-review": status = "FAILED"; break;
    case "done":
      if (result?.success !== true) throw new Error("Invalid payroll outcome");
      status = verification?.status === "FAILED" ? "FAILED" : "SCHEDULED";
      break;
    default: throw new Error("Invalid payroll state");
  }
  const settlement = validatePayrollSettlement(value, now);
  if (settlement) {
    if ((request.status !== "done" && request.status !== "failed" && request.status !== "needs-review")
      || (request.status === "done" && result?.success !== true) || verification?.status === "FAILED") {
      throw new Error("Conflicting payroll payment verification");
    }
    status = "PAID";
  }
  return { id: transfer.id, period: transfer.period, submittedAt: transfer.submittedAt,
    effectiveDate: transfer.effectiveDate, amountSatang: transfer.amountSatang,
    employeeCount: transfer.employeeCount, status, paidDate: settlement?.paidDate ?? null };
}

/** Strict reader: a missing/broken queue is an error, never an empty complete snapshot. */
export async function readPayrollLedgerSnapshot(since: string, options: { queueDir?: string; now?: Date } = {}) {
  if (!canonicalPayrollInstant(since)) throw new Error("Invalid payroll sync start");
  const queueDir = options.queueDir ?? process.env.QUEUE_DIR ?? "data/queue";
  const now = options.now ?? new Date();
  const files = (await readdir(queueDir)).filter((file) => file.endsWith(".json")
    && file !== "payee-handles.json" && file !== "kbiz-favorites.json");
  if (files.length > 10000) throw new Error("Payroll snapshot limit exceeded");
  const items: PayrollLedgerItem[] = [];
  const ids = new Set<string>();
  const paidReferences = new Set<string>();
  for (const file of files) {
    // Do not use listRequests(): it skips parse/read failures for the UI, which
    // would falsely claim a complete snapshot while the bot rewrites a file.
    const request = payrollObject(JSON.parse(await readFile(join(queueDir, file), "utf8")));
    if (!request) throw new Error("Invalid payroll queue data");
    if (typeof request.app === "string" && request.app !== "payroll") continue;
    if (request.type === "add-payroll" || request.type === "list-registered") continue;
    if (request.type !== "transfer-payroll" || !canonicalPayrollInstant(request.createdAt)) {
      throw new Error("Invalid payroll queue data");
    }
    // A bank payment can belong to only one request, including history that
    // falls before activation. Looking at its proof does not backfill that row.
    const proof = validatePayrollSettlement(request, now);
    if (proof) {
      const reference = proof.referenceNo.replace(/\s/g, "").toUpperCase();
      if (paidReferences.has(reference)) throw new Error("Payroll payment reference is already linked");
      paidReferences.add(reference);
    }
    if (request.createdAt < since) continue;
    const item = ledgerItem(request, now);
    if (file !== `${item.id}.json` || ids.has(item.id)) throw new Error("Invalid payroll queue identity");
    if (item.submittedAt > now.toISOString()) throw new Error("Invalid payroll submission date");
    ids.add(item.id);
    items.push(item);
    if (items.length > 5000) throw new Error("Payroll snapshot limit exceeded");
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1 as const, complete: true as const, since, generatedAt: now.toISOString(), items };
}

export function createPayrollLedgerFeed(options: { token?: () => string; queueDir?: string; now?: () => Date } = {}) {
  return new Elysia({ name: "payroll-ledger-feed" })
    .get("/api/ledger-feed/payroll", async ({ headers, query, set }) => {
      set.headers["cache-control"] = "no-store";
      if (!payrollLedgerAuthorized(headers.authorization, options.token?.() ?? process.env.PAYROLL_LEDGER_FEED_TOKEN ?? "")) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!canonicalPayrollInstant(query.since)) {
        set.status = 400;
        return { error: "invalid since" };
      }
      try {
        return await readPayrollLedgerSnapshot(query.since, { queueDir: options.queueDir, now: options.now?.() });
      } catch {
        // File names, bank result text and source records can contain payroll
        // information. Never pass raw errors into HTTP responses or logs.
        set.status = 503;
        return { error: "payroll snapshot unavailable" };
      }
    });
}
