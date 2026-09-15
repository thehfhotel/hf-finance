import { readdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  payrollObject,
  payrollRequestFingerprint,
} from "../../../src/payroll-settlement";

export type PayrollVerificationQueueItem = {
  file: string;
  archived: boolean;
  value: Record<string, unknown>;
};
/** Global claims include archive records, even if they are outside sync scope. */
export async function readPayrollVerificationQueue(
  queueDir: string,
): Promise<PayrollVerificationQueueItem[]> {
  const all: PayrollVerificationQueueItem[] = [];
  for (const dir of [queueDir, join(queueDir, "archive")]) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (e) {
      if (dir !== queueDir && (e as NodeJS.ErrnoException).code === "ENOENT")
        continue;
      throw Error("PAYROLL_QUEUE_UNREADABLE");
    }
    for (const file of files) {
      if (
        !file.endsWith(".json") ||
        file === "payee-handles.json" ||
        file === "kbiz-favorites.json"
      )
        continue;
      const value = payrollObject(
        JSON.parse(await readFile(join(dir, file), "utf8")),
      );
      if (
        !value ||
        typeof value.id !== "string" ||
        typeof value.type !== "string" ||
        typeof value.status !== "string" ||
        ![
          "transfer-payroll",
          "add-payroll",
          "list-registered",
          "transfer-other",
          "list-favorites",
        ].includes(value.type)
      )
        throw Error("PAYROLL_QUEUE_RECORD_INVALID");
      all.push({ file: join(dir, file), archived: dir !== queueDir, value });
    }
  }
  const ids = all.map((r) => r.value.id);
  if (new Set(ids).size !== ids.length)
    throw Error("PAYROLL_QUEUE_DUPLICATE_ID");
  return all;
}

export async function patchPayrollVerification(
  original: { file: string; value: Record<string, unknown> },
  patch: Record<string, unknown>,
): Promise<void> {
  const current = payrollObject(
    JSON.parse(await readFile(original.file, "utf8")),
  );
  if (
    !current ||
    current.status !== original.value.status ||
    current.payrollSettlement ||
    payrollRequestFingerprint(current) !==
      payrollRequestFingerprint(original.value)
  )
    return;
  const temp = original.file + ".bank-check.tmp";
  await writeFile(
    temp,
    JSON.stringify(
      { ...current, ...patch, updatedAt: new Date().toISOString() },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await rename(temp, original.file);
}
