// K BIZ QR login handoff — payroll-form's READ side (CR-2026-09-17).
//
// Since June 2026 K BIZ demands a scan from the K BIZ phone app after
// user/pass on every web login, so kbiz-bot cannot log in unattended. The bot
// publishes the bank's QR to a directory both containers mount; this module
// reads it back and payroll-form serves it on a Cloudflare-Access-gated route
// (`/kbiz/login-qr`, wired in `src/index.ts`).
//
// Read-only, fs-only, fixed filenames. It never writes, never lists the
// directory, and never takes a filename from a request — the only two files
// that exist in this contract are the two constants below, so no request can
// steer a read anywhere else.
//
// The directory is resolved PER CALL (not once at import) so the route can be
// pointed at a fixture dir in tests without restarting the process.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderKbizLoginQrPage } from "./views/kbiz-login-qr";

/** Written by the bot; the only two names this module ever reads. */
export const KBIZ_QR_STATE_FILE = "state.json";
export const KBIZ_QR_PNG_FILE = "current.png";

/**
 * `idle` is payroll-form's own synthesis for "the bot has never published
 * here / there is nothing pending"; the bot only ever writes the other four.
 */
export type KbizQrStatus = "idle" | "waiting" | "ok" | "expired" | "error";

const BOT_STATUSES = new Set<string>(["waiting", "ok", "expired", "error"]);

/**
 * The published state, narrowed to the contract's fields. Anything else in the
 * file is dropped rather than forwarded — this response leaves the origin.
 */
export type KbizQrState = {
  status: KbizQrStatus;
  reason?: string;
  attempt?: number;
  capturedAt?: string | null;
  expiresAt?: string | null;
  updatedAt?: string | null;
  message?: string;
};

/** `KBIZ_QR_DIR` ?? `data/qr-login` (cwd `/app` in the container). */
export function kbizQrDir(dir?: string): string {
  return dir ?? process.env.KBIZ_QR_DIR ?? "data/qr-login";
}

const NO_STORE = "private, no-store";

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const instant = (value: unknown): string | null | undefined =>
  typeof value === "string" && value.length > 0 ? value : value === null ? null : undefined;

function normalize(parsed: unknown): KbizQrState {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "error" };
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.status !== "string" || !BOT_STATUSES.has(raw.status)) return { status: "error" };
  const state: KbizQrState = { status: raw.status as KbizQrStatus };
  const reason = str(raw.reason);
  if (reason !== undefined) state.reason = reason;
  if (typeof raw.attempt === "number" && Number.isInteger(raw.attempt) && raw.attempt > 0) {
    state.attempt = raw.attempt;
  }
  for (const key of ["capturedAt", "expiresAt", "updatedAt"] as const) {
    const value = instant(raw[key]);
    if (value !== undefined) state[key] = value;
  }
  const message = str(raw.message);
  if (message !== undefined) state.message = message;
  return state;
}

/**
 * Never throws. Missing file (or missing directory) is `idle` — the contract's
 * synthesised state. Anything unreadable or malformed is `error`, because a
 * broken publish must not look like "nothing is pending".
 */
export async function readKbizQrState(dir?: string): Promise<KbizQrState> {
  let text: string;
  try {
    text = await readFile(join(kbizQrDir(dir), KBIZ_QR_STATE_FILE), "utf8");
  } catch (err) {
    const code = (err as { code?: string })?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? { status: "idle" } : { status: "error" };
  }
  try {
    return normalize(JSON.parse(text));
  } catch {
    return { status: "error" };
  }
}

/** The published PNG bytes, or `null` when there is no readable QR on disk. */
export async function readKbizQrPng(dir?: string): Promise<Uint8Array | null> {
  try {
    return await readFile(join(kbizQrDir(dir), KBIZ_QR_PNG_FILE));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route bodies. Kept beside the reader (rather than inline in `src/index.ts`)
// so the same three responses tests exercise are the ones the app serves.
// Every one is `private, no-store`: the QR is single-use and short-lived, and
// the page is only ever correct for the instant it was rendered.
// ---------------------------------------------------------------------------

export async function kbizLoginQrPageResponse(options: { dir?: string } = {}): Promise<Response> {
  const state = await readKbizQrState(options.dir);
  return new Response(renderKbizLoginQrPage(state), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": NO_STORE },
  });
}

export async function kbizLoginQrStateResponse(options: { dir?: string } = {}): Promise<Response> {
  const state = await readKbizQrState(options.dir);
  return new Response(JSON.stringify(state), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": NO_STORE },
  });
}

/**
 * The PNG exists only while a scan is actually pending: `waiting` in the state
 * file AND `current.png` on disk. A stale image left behind by a crashed
 * publish must never be shown as if it were scannable.
 */
export async function kbizLoginQrPngResponse(options: { dir?: string } = {}): Promise<Response> {
  const dir = kbizQrDir(options.dir);
  const state = await readKbizQrState(dir);
  const png = state.status === "waiting" ? await readKbizQrPng(dir) : null;
  if (!png) {
    return new Response("no QR pending", { status: 404, headers: { "cache-control": NO_STORE } });
  }
  return new Response(png, {
    headers: { "content-type": "image/png", "cache-control": NO_STORE },
  });
}
