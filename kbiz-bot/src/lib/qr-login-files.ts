/**
 * The QR publication on disk: where `current.png` + `state.json` live, how
 * they are written, and how a killed handoff's leftovers are swept.
 *
 * fs-only and playwright-free on purpose — the same split arm-lock.ts has.
 * The driver (qr-login.ts) binds a Page; this file binds a directory, so the
 * publication can be tested against a real temp dir under root `bun test`,
 * before kbiz-bot's node_modules exist.
 *
 * The `dir` parameters ARE the test seam. Nothing in production passes one:
 * the bot always publishes to QR_DIR.
 */

import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeAtomic } from "./fs-atomic";
import { terminalState, type QrLoginState } from "./qr-login-core";

/**
 * Where the QR is published. Default `../data/qr-login` = `/app/data/qr-login`
 * in the container (WORKDIR is /app/kbiz-bot), i.e. the payroll-stack-local
 * `./data` bind — host `/home/deploy/payroll-production/data/qr-login`.
 *
 * NOT the cross-stack `/home/deploy/kbiz-queue` mount: that one is bound in
 * per-subdirectory (`queue/`, `slips/`, `vouchers/`) and no nested bind covers
 * `qr-login/`, so a file written there would be visible to kbiz-bot alone and
 * payroll-form would serve a permanently-idle page. payroll-form reads
 * `process.env.KBIZ_QR_DIR ?? "data/qr-login"` from its own cwd (/app) — the
 * same host directory by a different in-container path.
 */
export const QR_DIR = process.env.KBIZ_QR_DIR ? resolve(process.env.KBIZ_QR_DIR) : resolve("..", "data", "qr-login");
export const QR_PNG_FILE = "current.png";
export const QR_STATE_FILE = "state.json";

/** Atomic (fs-atomic.ts): payroll-form polls these files every 5 s, so a
 *  reader must never catch a half-written PNG or a truncated JSON object. */
export function writeQrPng(bytes: Uint8Array, dir: string = QR_DIR): void {
  writeAtomic(join(dir, QR_PNG_FILE), bytes);
}

export function writeQrState(state: QrLoginState, dir: string = QR_DIR): void {
  writeAtomic(join(dir, QR_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** Never throws: the PNG is absent in every non-`waiting` state, so "already
 *  gone" is the normal case, not an error. */
export function removeQrPng(dir: string = QR_DIR): void {
  try {
    rmSync(join(dir, QR_PNG_FILE), { force: true });
  } catch {}
}

/**
 * Sweep a publication a killed handoff may have left behind: remove the PNG
 * (a `current.png` on disk is the claim "a live QR is waiting right now") and,
 * if `state.json` still says `waiting`, settle it to `expired` — otherwise the
 * operator page keeps rendering a dead handoff's reason and a long-past
 * countdown, image-less, until the next login. Never throws.
 */
export function clearStaleQrPublication(dir: string = QR_DIR): void {
  removeQrPng(dir);
  let stale: Partial<QrLoginState> | null = null;
  try {
    const parsed = JSON.parse(readFileSync(join(dir, QR_STATE_FILE), "utf8")) as Partial<QrLoginState>;
    if (parsed && parsed.status === "waiting") stale = parsed;
  } catch {
    return; // no state file, or unreadable — nothing to settle
  }
  if (!stale) return;
  try {
    writeQrState(
      terminalState({
        status: "expired",
        reason: typeof stale.reason === "string" ? stale.reason : "",
        attempt: typeof stale.attempt === "number" ? stale.attempt : 0,
        atMs: Date.now(),
        message: "Interrupted before any scan",
      }),
      dir,
    );
  } catch {}
}
