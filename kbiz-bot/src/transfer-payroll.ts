import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { withSession } from "./lib/session";
import { runTransferPayrollFlow } from "./flows/transfer-payroll-flow";
import { conservativeLock, parseArmLock, releasedLock } from "./lib/arm-gate";
import { readArmLockRaw, writeArmLock } from "./lib/arm-lock";

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npm run transfer-payroll -- <path/to/xlsx>");
  process.exit(1);
}
const abs = resolve(filePath);
if (!existsSync(abs)) { console.error(`File not found: ${abs}`); process.exit(1); }

// ── arm lock ──────────────────────────────────────────────────────────────
// This script has no preview mode: it uploads, clicks Next, then Confirm, and
// Confirm ARMS THE PHONE PUSH. So it plays by the same estate-wide rule as
// process-queue.ts and transfer-other.ts --confirm — one live approval push
// anywhere, ever (incidents 2026-08-12 + 2026-08-13; a push armed seconds
// after the previous tap raises no banner at all).
//
// Two halves, and both are load-bearing: REFUSE under someone else's live
// lock, and WRITE our own so the container's 30 s watch loop cannot arm a
// money push on top of this run.
const now = Date.now();
const { text, mtimeMs } = readArmLockRaw();
const lock = parseArmLock(text, mtimeMs, now);
if (lock.live) {
  const armed = lock.armedAt !== undefined ? new Date(lock.armedAt).toISOString() : "an unknown time";
  const until = new Date(lock.until).toISOString();
  const left = Math.ceil((lock.until - now) / 1000);
  console.error(
    `\n❌ An approval push armed at ${armed} may still be live until ${until} (~${left}s) — ` +
      `refusing to arm a second one. Tap or let the first one expire, then re-run. ` +
      `(lock: ${lock.source})\n`,
  );
  process.exit(1);
}

// Conservative lock BEFORE the flow — it covers the upload + review window a
// crash could land in. FAIL CLOSED: a disk that cannot record the hold cannot
// be trusted to prevent a double pay.
const acquired = conservativeLock("cli-transfer-payroll", Date.now());
try {
  writeArmLock(acquired);
} catch (e) {
  console.error(`\n❌ Could not record the arm lock (${(e as Error).message}) — refusing to arm.\n`);
  process.exit(1);
}

await withSession(async (_ctx, page) => {
  const result = await runTransferPayrollFlow(page, abs);

  // RELEASE only on a provably dead outcome: the expected bank confirmation
  // page (tap consumed), or a refusal before Confirm (never armed). An auth or
  // error redirect sets pushMayBeLive and keeps the lock. A THROW — including the
  // 5-minute waitForMobileConfirmation timeout — skips this deliberately and
  // leaves the conservative lock standing until it expires.
  const pushMayBeLive = !result.success && result.pushMayBeLive === true;
  if (!pushMayBeLive) {
    try {
      // Hardcoded pair stays binary: transfer-payroll-flow.ts has no
      // push-expired detection (that lives in approval-wait.ts, which only
      // transfer-other's wait loop calls) and no duplicate-popup handling —
      // payroll cannot produce either new outcome, so "success" / one
      // catch-all failure is still the whole space here (kbiz-fix-spec.md
      // IMPL-C worksheet item 3; source-grepped by arm-gate.test.ts).
      writeArmLock(releasedLock(acquired, result.success ? "success" : "confirmed-failed", Date.now()));
    } catch (e) {
      console.warn(`⚠ could not release the arm lock: ${(e as Error).message}`);
    }
  }

  if (result.success) {
    console.log(`\n✅ Submitted to bank. Settlement is verified from payroll history. final URL: ${result.finalUrl}`);
  } else {
    console.error(`\n❌ Failed: ${result.error}`);
    process.exit(1);
  }
});
