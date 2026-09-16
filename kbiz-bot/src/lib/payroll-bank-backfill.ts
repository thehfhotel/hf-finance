import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalPayrollInstant, payrollObject } from "../../../src/payroll-settlement";

// Deliberately NOT .json: payment queue scanners ignore these control files.
export const BACKFILL_REQUEST_FILE = ".payroll-bank-backfill.request";
export const BACKFILL_CLAIMED_FILE = ".payroll-bank-backfill.claimed";
export type PayrollBackfillRequest = {
  id: string;
  requestedAt: string;
  requestId?: string;
};
const REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

function parseRequest(text: string): PayrollBackfillRequest {
  const r = payrollObject(JSON.parse(text));
  if (!r || typeof r.id !== "string" || !REQUEST_ID.test(r.id) ||
    !canonicalPayrollInstant(r.requestedAt) ||
    (r.requestId !== undefined && (typeof r.requestId !== "string" || !REQUEST_ID.test(r.requestId)))) {
    throw Error("PAYROLL_BACKFILL_REQUEST_INVALID");
  }
  return r as PayrollBackfillRequest;
}

/** Queue only: no browser, bank login, transfer, or payment approval. */
export async function requestPayrollBackfill(
  queueDir: string,
  requestId?: string,
): Promise<PayrollBackfillRequest> {
  if (requestId !== undefined && !REQUEST_ID.test(requestId))
    throw Error("PAYROLL_BACKFILL_REQUEST_ID_INVALID");
  const request: PayrollBackfillRequest = {
    id: randomUUID(), requestedAt: new Date().toISOString(),
    ...(requestId === undefined ? {} : { requestId }),
  };
  const temp = join(queueDir, `.payroll-bank-backfill-${request.id}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(request), { flag: "wx", mode: 0o600 });
    // Atomic publish with no overwrite: the watcher cannot read a partial file,
    // and a second manual request cannot replace one it has already inspected.
    await link(temp, join(queueDir, BACKFILL_REQUEST_FILE));
  } finally {
    await rm(temp, { force: true });
  }
  return request;
}

export async function readPayrollBackfillRequest(
  queueDir: string,
): Promise<PayrollBackfillRequest | null> {
  try {
    return parseRequest(await readFile(join(queueDir, BACKFILL_REQUEST_FILE), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw Error("PAYROLL_BACKFILL_REQUEST_UNREADABLE");
  }
}

/**
 * Only the serialized queue worker claims requests, after its payment/arm-lock
 * guards. Claim BEFORE bank access: even a crash or outage cannot turn a manual
 * backfill into endless retries. The claimed file is an audit marker, not bank
 * proof. A fresh explicit request is needed to repeat an old backfill.
 */
export async function claimPayrollBackfillRequest(
  queueDir: string,
  expected: PayrollBackfillRequest,
): Promise<boolean> {
  const current = await readPayrollBackfillRequest(queueDir);
  if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
  await rename(join(queueDir, BACKFILL_REQUEST_FILE), join(queueDir, BACKFILL_CLAIMED_FILE));
  return true;
}
