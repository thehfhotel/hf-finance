import { resolve } from "node:path";
import { requestPayrollBackfill } from "./lib/payroll-bank-backfill";

// This command ONLY queues a read-only check. The running serialized worker
// does the bank access when idle; never start a second bank browser here.
try {
  const args = process.argv.slice(2);
  if (args.length !== 0 &&
    !(args.length === 2 && args[0] === "--request-id" && /^[A-Za-z0-9_-]{1,100}$/.test(args[1]))) {
    throw Error("Usage: node --import tsx src/request-payroll-bank-backfill.ts [--request-id ID]");
  }
  const dir = process.env.KBIZ_QUEUE_DIR
    ? resolve(process.env.KBIZ_QUEUE_DIR) : resolve("..", "data", "queue");
  await requestPayrollBackfill(dir, args[1]);
  console.log("Queued one read-only payroll backfill. The worker will check it when idle; PAYROLL_BANK_VERIFY_SINCE must be enabled.");
} catch (e) {
  console.error((e as NodeJS.ErrnoException).code === "EEXIST"
    ? "A payroll backfill request is already pending; it was not overwritten."
    : (e as Error).message);
  process.exitCode = 1;
}
