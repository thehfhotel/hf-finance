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

import { readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeAtomic } from "./fs-atomic";
import { terminalState, type QrLoginState } from "./qr-login-core";
import type { KbizSessionFile } from "./session-keeper-core";

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
/** The resident keeper's published record (CR-2026-09-17). */
export const QR_SESSION_FILE = "session.json";
/** What payroll-form writes when the operator presses the button. */
export const LOGIN_REQUEST_FILE = "login.request";
/** Where the bot renames it, BEFORE it touches the bank. */
export const LOGIN_REQUEST_CLAIMED_FILE = "login.request.claimed";

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

// ── The resident session record ───────────────────────────────────────────

/**
 * Publish what the keeper knows. Atomic like everything else here: payroll-form
 * polls this file every 5 s to decide which of its four page states to render,
 * and a truncated object would read as "no session" — i.e. it would offer the
 * login button while a session is perfectly alive.
 */
export function writeSessionFile(session: KbizSessionFile, dir: string = QR_DIR): void {
  writeAtomic(join(dir, QR_SESSION_FILE), `${JSON.stringify(session, null, 2)}\n`);
}

// ── The operator's login request ──────────────────────────────────────────

/** `login.request`, as payroll-form writes it. */
export interface KbizLoginRequest {
  /** ISO. Empty string when the file was unreadable (see readLoginRequest). */
  requestedAt: string;
  /** The cf-access-authenticated-user-email header, or "unknown". */
  by: string;
}

/** Keeps a header-supplied value from becoming a multi-line Slack line or a
 *  novel in `state.json`'s `reason`. Not a validator — the value is only ever
 *  displayed, never trusted. */
function sanitizeRequestedBy(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  // \p{C} = every control/format code point, so a header carrying a newline or
  // a zero-width joiner cannot reshape a Slack line or a JSON-rendered page.
  const clean = value.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 120) : "unknown";
}

/**
 * Read the pending request, or null when there is none.
 *
 * A file that exists but does not parse still returns a request (with an empty
 * `requestedAt`), deliberately: the file's PRESENCE is the operator's ask, and
 * returning null for a malformed one would leave it on disk forever, with
 * payroll-form stuck rendering "กำลังเตรียม QR…" and the bot ignoring it. The
 * claim below is what removes it, so a request we cannot read is still a
 * request we answer once and clear.
 */
export function readLoginRequest(dir: string = QR_DIR): KbizLoginRequest | null {
  let text: string;
  try {
    text = readFileSync(join(dir, LOGIN_REQUEST_FILE), "utf8");
  } catch {
    return null; // no file (or unreadable directory) — nothing was asked for
  }
  try {
    const parsed = JSON.parse(text) as Partial<KbizLoginRequest>;
    return {
      requestedAt: typeof parsed?.requestedAt === "string" ? parsed.requestedAt : "",
      by: sanitizeRequestedBy(parsed?.by),
    };
  } catch {
    return { requestedAt: "", by: "unknown" };
  }
}

/**
 * CLAIM the request by renaming it to `login.request.claimed`, overwriting any
 * previous claimed file — the same request/claim shape payroll-bank-backfill.ts
 * uses, for the same reason: the claim happens BEFORE the bank is touched, so a
 * crash, a bank outage or an unscanned QR can never turn one press of the
 * button into an endless retry loop. payroll-form never deletes either file; a
 * new login is a new press.
 *
 * `rename(2)` is atomic and replaces the destination, so no window exists in
 * which both files are present or neither is. Returns false when there was
 * nothing to claim (the normal case on almost every tick).
 */
export function claimLoginRequest(dir: string = QR_DIR): boolean {
  try {
    renameSync(join(dir, LOGIN_REQUEST_FILE), join(dir, LOGIN_REQUEST_CLAIMED_FILE));
    return true;
  } catch {
    return false;
  }
}
