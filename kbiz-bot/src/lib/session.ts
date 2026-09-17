import { chromium, type BrowserContext, type Page } from "playwright";
import { resolve } from "node:path";
import { isUnauthenticatedUrl } from "./approval-wait";
import {
  isQrLoginUrl,
  KBIZ_DASHBOARD_URL,
  KBIZ_LOGIN_FORM_SELECTOR,
  maskQrMessage,
  QrLoginRequiredError,
} from "./qr-login-core";
import { runQrLoginHandoff } from "./qr-login";
import { stabiliseSession } from "./session-probe";

const USER_DATA_DIR = resolve("browser-data");
// lang=th since 2026-08-12: the picker's Account Name column renders the
// bank's THAI name-on-account under a Thai session (English romanizes it),
// and reimbursement wants Thai names. Every text matcher that navigates the
// UI is bilingual, and bank matching goes through aliasesForBank().
const LOGIN_URL = "https://kbiz.kasikornbank.com/authen/login.jsp?lang=th";

/**
 * What a caller is willing to do when K BIZ demands a QR scan (it does, on
 * EVERY web login since June 2026 — see qr-login-core.ts).
 *
 * `"refuse"` is the DEFAULT and stays the default for every existing caller:
 * a scrape, a flow or the payroll settlement check has no business making a
 * human walk to a phone, so it throws `QrLoginRequiredError` at once and lets
 * its own unavailable-path handle it. Only the batch warm-up in
 * process-queue.ts and the operator's `npm run login` pass `"handoff"` — and
 * a `reason` with it, which is REQUIRED there and meaningless anywhere else:
 * it is published in the QR state file and in every Slack line the handoff
 * posts, so there is no fallback for this file to invent.
 */
export type LoginOptions = { onQr?: "refuse"; reason?: string } | { onQr: "handoff"; reason: string };

// Moved to approval-wait.ts (a pure, playwright-free module) so the
// post-"Next" approval wait loop can import it without dragging playwright
// into `bun test`. Re-exported here so every existing importer of
// session.ts (this file's own use below, transfer-other-flow.ts:3) keeps
// working unchanged.
export { isUnauthenticatedUrl };

export async function withSession<T>(fn: (ctx: BrowserContext, page: Page) => Promise<T>): Promise<T> {
  const headless = process.env.KBIZ_HEADLESS === "1";
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    slowMo: headless ? 0 : 50,
    viewport: { width: 1366, height: 800 },
  });
  ctx.on("page", (p) =>
    p.on("framenavigated", (frame) => {
      // Masked: since June 2026 every re-login parks on
      // `/authen/loginQR.do?cmd=<session token>`, and this hook fires on every
      // main-frame navigation — unmasked it would write the bank's
      // login-challenge query string into the container log on every login.
      if (frame === p.mainFrame()) console.log(`   ↳ ${maskQrMessage(frame.url())}`);
    })
  );
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    return await fn(ctx, page);
  } finally {
    await ctx.close();
  }
}

async function loginFlow(page: Page, opts?: LoginOptions): Promise<void> {
  const username = process.env.KBIZ_USERNAME;
  const password = process.env.KBIZ_PASSWORD;
  if (!username || !password) throw new Error("Set KBIZ_USERNAME and KBIZ_PASSWORD in kbiz-bot/.env");

  console.log("→ Logging in …");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.locator(KBIZ_LOGIN_FORM_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });
  await page.locator(KBIZ_LOGIN_FORM_SELECTOR).fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#loginBtn").click();
  // Since June 2026 user/pass is only half a login: the bank answers
  // `#loginBtn` with `/authen/loginQR.do?cmd=…` and waits for a scan from the
  // K BIZ phone app (live-verified 2026-09-17). `loginQR.do` IS an /authen
  // URL, so it has to be an accepted exit from this wait — otherwise every
  // re-login burned the full 60 s and then threw, crashing the first item of
  // the batch and leaving the conservative arm lock standing for ~10 min.
  await page.waitForURL((url) => !isUnauthenticatedUrl(url.toString()) || isQrLoginUrl(url.toString()), {
    timeout: 60_000,
  });
  if (isQrLoginUrl(page.url())) {
    if (opts?.onQr !== "handoff") {
      // No wait at all: nothing this caller can do will make the QR go away,
      // and a human is not going to be summoned on its behalf.
      throw new QrLoginRequiredError();
    }
    // Returns only once the dashboard is CONFIRMED (or throws
    // QrLoginTimeoutError). Never resubmits credentials.
    await runQrLoginHandoff(page, { reason: opts.reason });
    console.log("✓ Logged in");
    return;
  }
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  console.log("✓ Logged in");
}

/**
 * Navigate to `url` as an authenticated user. If KBIZ bounces us to
 * /error, /login, or /authen — recover by re-running loginFlow once and
 * retrying the target. The /error page even tells the user "Go to login
 * page"; we just do that programmatically.
 *
 * KBIZ does an async session check after initial render, so we stabilize
 * for a moment before judging the URL.
 */
export async function gotoAuthenticated(page: Page, url: string, opts?: LoginOptions): Promise<void> {
  const tryOnce = async () => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    // KBIZ runs an async session check on every navigation — sometimes it
    // takes 2-5 seconds before the SPA decides to bounce to /error. We poll
    // the URL + the visible "session expired" text up to 6s, and declare
    // success only if neither shows up. ONE copy of that poll, shared with the
    // QR handoff's confirmDashboard (session-probe.ts): two copies could drift
    // into the handoff publishing `ok` for a session this function calls dead.
    if (!(await stabiliseSession(page))) return false;
    return !isUnauthenticatedUrl(page.url());
  };

  console.log("→ Navigating to", url);
  if (await tryOnce()) return;

  console.log("   bounced to", maskQrMessage(page.url()), "— recovering");
  await loginFlow(page, opts);
  console.log("→ Retrying", url);
  if (await tryOnce()) return;

  // Masked: this message reaches a queue item's `result.error` and Slack, and
  // the URL it carries is very often the bank's `loginQR.do?cmd=<token>`.
  throw new Error(`After re-login still bouncing — final URL: ${maskQrMessage(page.url())}`);
}

export async function ensureLoggedIn(page: Page, opts?: LoginOptions): Promise<void> {
  await gotoAuthenticated(page, KBIZ_DASHBOARD_URL, opts);
}
