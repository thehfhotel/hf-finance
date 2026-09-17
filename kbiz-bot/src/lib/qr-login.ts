/**
 * The thin driver half of the K BIZ QR-login handoff: it binds a Playwright
 * Page to the pure state machine in qr-login-core.ts, the publication on disk
 * (qr-login-files.ts) and the Slack webhook (slack.ts). All the meaning lives
 * there; this file only reads attributes and wires the seams together.
 *
 * Imports playwright, so nothing under test/ and no pure module may import
 * THIS file (root CI runs `bun test` without kbiz-bot's node_modules).
 * session.ts — already a playwright module — is the only importer.
 */

import type { Page } from "playwright";
import { stabiliseSession } from "./session-probe";
import { clearStaleQrPublication, QR_DIR, removeQrPng, writeQrPng, writeQrState } from "./qr-login-files";
import { notifySlack } from "./slack";
import {
  DEFAULT_QR_PAGE_URL,
  KBIZ_DASHBOARD_URL,
  KBIZ_LOGIN_FORM_SELECTOR,
  runQrHandoff,
  type QrLoginView,
} from "./qr-login-core";

/** The link Slack sends the operator. The one env override lives here, at the
 *  driver; the core takes `pageUrl` as a plain required string. */
const QR_PAGE_URL = process.env.KBIZ_QR_PAGE_URL ?? DEFAULT_QR_PAGE_URL;

/**
 * Positive proof of a live session — literally the same probe
 * `gotoAuthenticated` makes (KBIZ runs an async session check after first
 * paint and can bounce 2-5 s later, so the URL right after a redirect proves
 * nothing): be on the dashboard, run `stabiliseSession` (12×500 ms, shared
 * with session.ts so neither copy can drift), and declare success only if
 * nothing bounced us, the URL is a `/menu/` page and the login form is not
 * on screen.
 */
async function confirmDashboard(page: Page): Promise<boolean> {
  try {
    // Already on a `/menu/` page means the bank has just redirected itself
    // there — navigating again would only throw the freshly-minted session at
    // another round trip. The proof below is unchanged either way.
    if (!page.url().includes("/menu/")) {
      await page.goto(KBIZ_DASHBOARD_URL, { waitUntil: "domcontentloaded" });
    }
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
    .locator(KBIZ_LOGIN_FORM_SELECTOR)
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
function playwrightQrView(page: Page): QrLoginView {
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
    writePng: async (bytes) => writeQrPng(bytes),
    writeState: async (state) => writeQrState(state),
    removePng: async () => removeQrPng(),
    notify: notifySlack,
  };
}

/**
 * Run the handoff against a live page parked on `loginQR.do`. Returns once the
 * dashboard is confirmed; throws `QrLoginTimeoutError` if nobody scanned in
 * time. Never resubmits credentials, never retries past the human.
 */
export async function runQrLoginHandoff(page: Page, opts: { reason: string }): Promise<void> {
  console.log(`→ K BIZ wants a QR scan — publishing it to ${QR_DIR}`);
  // No live QR can exist at handoff ENTRY, so anything still on disk is a
  // killed handoff's leftover claim that one is waiting — sweep it first.
  clearStaleQrPublication();
  await runQrHandoff(playwrightQrView(page), { reason: opts.reason, pageUrl: QR_PAGE_URL });
  console.log("✓ QR scanned — session is live");
}
