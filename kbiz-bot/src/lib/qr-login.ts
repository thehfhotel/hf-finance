/**
 * The thin driver half of the K BIZ QR-login handoff: it binds a Playwright
 * Page, the published directory and the Slack webhook to the pure state
 * machine in qr-login-core.ts. All the meaning lives there; this file only
 * reads attributes, moves bytes and POSTs text.
 *
 * Imports playwright, so nothing under test/ and no pure module may import
 * THIS file (root CI runs `bun test` without kbiz-bot's node_modules).
 * session.ts — already a playwright module — is the only importer.
 */

import type { Page } from "playwright";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stabiliseSession } from "./session-probe";
import {
  DEFAULT_QR_PAGE_URL,
  KBIZ_DASHBOARD_URL,
  runQrHandoff,
  terminalState,
  type QrLoginState,
  type QrLoginView,
} from "./qr-login-core";

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
export const QR_PAGE_URL = process.env.KBIZ_QR_PAGE_URL ?? DEFAULT_QR_PAGE_URL;
export const QR_PNG_FILE = "current.png";
export const QR_STATE_FILE = "state.json";

const SLACK = process.env.SLACK_WEBHOOK_URL;

/**
 * The bot's one Slack voice. Lives here rather than in process-queue.ts so the
 * handoff driver and the queue loop post through the SAME helper (identical
 * fire-and-forget semantics: a webhook that is unset, slow or broken must
 * never turn a bank flow into a crash).
 */
export async function notifySlack(text: string): Promise<void> {
  if (!SLACK) return;
  try {
    await fetch(SLACK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {}
}

/** Atomic, exactly like arm-lock.ts: write `<name>.tmp`, then rename over it.
 *  payroll-form polls these files every 5 s, so a reader must never catch a
 *  half-written PNG or a truncated JSON object. */
function writeAtomic(dir: string, name: string, data: string | Uint8Array): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function writeQrPng(bytes: Uint8Array, dir: string = QR_DIR): void {
  writeAtomic(dir, QR_PNG_FILE, bytes);
}

export function writeQrState(state: QrLoginState, dir: string = QR_DIR): void {
  writeAtomic(dir, QR_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
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

/**
 * Positive proof of a live session — literally the same probe
 * `gotoAuthenticated` makes (KBIZ runs an async session check after first
 * paint and can bounce 2-5 s later, so the URL right after a redirect proves
 * nothing): navigate to the dashboard, run `stabiliseSession` (12×500 ms,
 * shared with session.ts so neither copy can drift), and declare success only
 * if nothing bounced us, the URL is a `/menu/` page and the login form is not
 * on screen.
 */
async function confirmDashboard(page: Page): Promise<boolean> {
  try {
    await page.goto(KBIZ_DASHBOARD_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    // The SAME poll gotoAuthenticated makes, from the same module — see
    // session-probe.ts. Then this function's own positive proof on top.
    if (!(await stabiliseSession(page))) return false;
    return page.url().includes("/menu/") && !(await loginFormVisible(page));
  } catch {
    return false;
  }
}

async function loginFormVisible(page: Page): Promise<boolean> {
  return page
    .locator("#userName")
    .first()
    .isVisible()
    .catch(() => false);
}

/**
 * The `QrLoginView` for a real page. `qrDataUri` reads the `src` ATTRIBUTE of
 * `img.qrcode` — never a screenshot: a screenshot would publish whatever else
 * the page is rendering (the bank's `loginQR.do?cmd=<token>` chrome included)
 * onto a page operators are told to trust, and it would re-encode the code.
 */
export function playwrightQrView(page: Page, opts?: { dir?: string }): QrLoginView {
  const dir = opts?.dir ?? QR_DIR;
  return {
    now: () => Date.now(),
    sleep: (ms: number) => page.waitForTimeout(ms),
    url: () => page.url(),
    qrDataUri: () =>
      page
        .locator("img.qrcode")
        .first()
        .getAttribute("src", { timeout: 2_000 })
        .catch(() => null),
    loginFormVisible: () => loginFormVisible(page),
    confirmDashboard: () => confirmDashboard(page),
    writePng: async (bytes) => writeQrPng(bytes, dir),
    writeState: async (state) => writeQrState(state, dir),
    removePng: async () => removeQrPng(dir),
    notify: notifySlack,
  };
}

/**
 * Run the handoff against a live page parked on `loginQR.do`. Returns once the
 * dashboard is confirmed; throws `QrLoginTimeoutError` if nobody scanned in
 * time. Never resubmits credentials, never retries past the human.
 */
export async function runQrLoginHandoff(page: Page, opts: { reason: string; pageUrl?: string }): Promise<void> {
  console.log(`→ K BIZ wants a QR scan — publishing it to ${QR_DIR}`);
  // `current.png` on disk is the claim "a live QR is waiting right now", and
  // payroll-form gates the image on `status === "waiting"` alone. At handoff
  // ENTRY no live QR can exist, so anything still here is a leftover from a
  // handoff that was killed mid-flow (a container recreate on deploy, an OOM)
  // — clear it (and settle a stale `waiting` state) before the first poll can
  // be believed.
  clearStaleQrPublication();
  await runQrHandoff(playwrightQrView(page), {
    reason: opts.reason,
    pageUrl: opts.pageUrl ?? QR_PAGE_URL,
  });
  console.log("✓ QR scanned — session is live");
}
