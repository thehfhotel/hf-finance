import {
  readPayrollVerificationQueue,
  patchPayrollVerification,
} from "./payroll-bank-files";
import { withSession } from "./session";
import { readArmLockRaw } from "./arm-lock";
import { parseArmLock } from "./arm-gate";
import { readPayrollBankHistory } from "./payroll-bank-reader";
import { decidePayrollBankVerification } from "./payroll-bank-core";
import {
  bangkokPayrollDate,
  canonicalPayrollInstant,
  payrollObject,
  validatePayrollTransfer,
} from "../../../src/payroll-settlement";

const RETRY_MS = 15 * 60_000;
/** Call only from the existing serialized queue loop, outside its money session. */
export async function checkPayrollBankSettlements(
  queueDir: string,
  now = new Date(),
): Promise<void> {
  const since = process.env.PAYROLL_BANK_VERIFY_SINCE;
  if (!canonicalPayrollInstant(since)) return;
  const all = await readPayrollVerificationQueue(queueDir);
  if (
    all.some(
      (r) =>
        !r.archived &&
        (r.value.status === "approved" || r.value.status === "running"),
    )
  )
    return;
  const raw = readArmLockRaw();
  const lock = parseArmLock(raw.text, raw.mtimeMs, now.getTime());
  if (lock.live || !["none", "released", "expired"].includes(lock.source))
    return;
  const candidates = all.filter(
    ({ archived, value: r }) =>
      !archived &&
      r.type === "transfer-payroll" &&
      canonicalPayrollInstant(r.createdAt) &&
      r.createdAt >= since &&
      !r.payrollSettlement &&
      ["done", "failed", "needs-review"].includes(String(r.status)) &&
      typeof r.startedAt === "string" &&
      (!canonicalPayrollInstant(
        payrollObject(r.payrollVerification)?.checkedAt,
      ) ||
        Date.parse(String(payrollObject(r.payrollVerification)?.checkedAt)) +
          RETRY_MS <=
          now.getTime()),
  );
  if (!candidates.length) return;
  const valid = candidates.filter((r) => {
    try {
      validatePayrollTransfer(r.value);
      return true;
    } catch {
      return false;
    }
  });
  if (!valid.length) return;
  const today = bangkokPayrollDate(now);
  const dates = new Set(
    valid
      .map((r) => validatePayrollTransfer(r.value).effectiveDate)
      .filter((d) => d <= today),
  );
  const input = all.map((r) => r.value);
  let batches: Awaited<ReturnType<typeof readPayrollBankHistory>> = [];
  if (dates.size) {
    const minDate = valid
      .map((r) => bangkokPayrollDate(new Date(String(r.value.createdAt))))
      .sort()[0];
    const display = (d: string) => d.split("-").reverse().join("/");
    try {
      batches = await withSession(async (_ctx, page) =>
        readPayrollBankHistory(page, {
          startDate: display(minDate),
          endDate: display(today),
          candidateDates: dates,
        }),
      );
    } catch {
      for (const r of valid)
        await patchPayrollVerification(r, {
          payrollVerification: {
            status: "UNKNOWN",
            reasonCode: "BANK_CHECK_UNAVAILABLE",
            checkedAt: now.toISOString(),
          },
        });
      console.warn(
        "Payroll bank verification unavailable; no payment status changed.",
      );
      return;
    }
  }
  for (const r of valid) {
    const result = decidePayrollBankVerification(r.value, batches, input, now);
    await patchPayrollVerification(r, result);
    Object.assign(r.value, result);
  }
  console.log(`Payroll bank verification checked ${valid.length} run(s).`);
}
