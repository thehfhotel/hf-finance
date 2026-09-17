/**
 * The one session-stabilisation probe, shared by the two places that need it.
 *
 * KBIZ runs an async session check AFTER first paint: a page can render, and
 * 2-5 s later the SPA bounces to /error or paints "your session has expired".
 * So neither `gotoAuthenticated` (session.ts) nor the QR handoff's
 * `confirmDashboard` (qr-login.ts) may judge a session by the URL it sees on
 * arrival — both poll for a few seconds first.
 *
 * It lives in its own module because session.ts imports qr-login.ts (for the
 * handoff) and qr-login.ts must therefore never import session.ts. Before this
 * file the loop and its "session expired" regex were simply copied into both,
 * which is a silent-drift hazard on the login path: tune one copy and the
 * handoff can publish `ok` for a session `gotoAuthenticated` calls dead.
 *
 * Playwright module — nothing under test/ and no pure module may import it.
 */

import type { Page } from "playwright";
import { isUnauthenticatedUrl } from "./approval-wait";

/**
 * The bank's own session-death copy, EN + TH, as a RegExp source string: it is
 * handed to `page.evaluate` as an argument rather than closed over, because
 * tsx/esbuild's keepNames rewrites named inner functions inside an evaluate
 * callback into `__name(...)`, which does not exist in the browser.
 */
const SESSION_DEAD_SOURCE =
  "Sorry[\\s\\S]+session has expired|session expired or you are signed in|เซสชัน(?:ของคุณ)?หมดอายุ|หมดเวลาการใช้งาน|เข้าสู่ระบบจากอุปกรณ์อื่น";

/** 12 × 500 ms = 6 s, long enough to outlive the bank's async check. */
const STABILISE_POLLS = 12;
const STABILISE_STEP_MS = 500;

/**
 * Poll the page for STABILISE_POLLS × STABILISE_STEP_MS.
 *
 * `false` as soon as the session proves dead (bounced to an unauthenticated
 * URL, or the expiry text painted); `true` if it survived every poll — which
 * is NOT by itself proof of being logged in, only proof that nothing bounced
 * us. Each caller adds its own positive check (a `/menu/` URL, no `#userName`)
 * on top.
 */
export async function stabiliseSession(page: Page): Promise<boolean> {
  for (let i = 0; i < STABILISE_POLLS; i++) {
    await page.waitForTimeout(STABILISE_STEP_MS);
    if (isUnauthenticatedUrl(page.url())) return false;
    const sessionDead = await page
      .evaluate((src: string) => new RegExp(src, "i").test((document.body as HTMLElement).innerText), SESSION_DEAD_SOURCE)
      .catch(() => false);
    if (sessionDead) return false;
  }
  return true;
}
