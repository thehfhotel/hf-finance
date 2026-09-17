/**
 * The disk half of the one-push-at-a-time invariant: read and atomically
 * write the single JSON file that records the estate's one outstanding
 * approval push. All the meaning lives in arm-gate.ts (pure); this file only
 * moves bytes.
 *
 * Durable ON PURPOSE. The hold has to survive a container restart — a crash
 * after the Next click leaves a push tappable at the bank for minutes, and the
 * bot that comes back up 5 s later must not arm on top of it. Nothing
 * in-process could carry that.
 *
 * `/app/data` is already a writable host bind (docker-compose.yml
 * `./data:/app/data`) with write precedent (scrape-registered.ts writes
 * kbiz-registered.json there), and it is NOT the queue dir — queue/, slips/
 * and vouchers/ are nested binds — so listApproved() can never mistake this
 * file for a request. No compose change, no ops step.
 *
 * Root CI runs `bun test` BEFORE kbiz-bot's node_modules exist — no
 * "playwright" import here, not even a type one.
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeAtomic } from "./fs-atomic";
import type { ArmLock } from "./arm-gate";

/**
 * Defaults to `../data` — the same `resolve("..", "data")` QUEUE_DIR and
 * capture-slip use, which is /app/data in the container (WORKDIR is
 * /app/kbiz-bot). KBIZ_STATE_DIR exists so a test or a second deployment can
 * point somewhere else; unset preserves today's layout exactly.
 */
export const STATE_DIR = process.env.KBIZ_STATE_DIR ? resolve(process.env.KBIZ_STATE_DIR) : resolve("..", "data");
export const ARM_LOCK_FILE = "kbiz-arm-lock.json";

/**
 * Raw bytes + mtime, NEVER throwing. A missing file is the overwhelmingly
 * common case (no push outstanding) and must read as "no lock", not as an
 * error that a caller might mistake for "cannot tell" — arm-gate.ts turns
 * `{null, null}` into `{live:false, source:"none"}`.
 *
 * mtime is read separately and independently: it is the fallback bound for a
 * CORRUPT file, so it must survive the case where the content is unusable.
 */
export function readArmLockRaw(dir: string = STATE_DIR): { text: string | null; mtimeMs: number | null } {
  const path = join(dir, ARM_LOCK_FILE);
  let text: string | null = null;
  let mtimeMs: number | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = null;
  }
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    mtimeMs = null;
  }
  return { text, mtimeMs };
}

/**
 * Atomic (fs-atomic.ts, shared with the QR publication): a reader either sees
 * the whole previous lock or the whole new one — never a half-written file
 * that parseArmLock would have to treat as corrupt (and therefore as LIVE,
 * wedging the bot for 10.5 min for no reason).
 *
 * THROWS on failure, deliberately: the caller must fail CLOSED. No lock, no
 * push. A disk that cannot record the hold is a disk that cannot be trusted to
 * prevent a double pay.
 */
export function writeArmLock(lock: ArmLock, dir: string = STATE_DIR): void {
  writeAtomic(join(dir, ARM_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
}
