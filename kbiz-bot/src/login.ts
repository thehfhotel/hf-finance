import { withSession, ensureLoggedIn } from "./lib/session";

// The operator pre-warm. `onQr: "handoff"` because a human is, by definition,
// already here: K BIZ answers user/pass with a QR page (since June 2026), so
// this publishes the QR to KBIZ_QR_DIR, pings Slack with the link and waits
// up to 6.5 min for the scan. In the container run it through
// scripts/kbiz-login-handoff.sh — the watch loop must be paused first or the
// two fight over the Chromium profile.
await withSession(async (_ctx, page) => {
  await ensureLoggedIn(page, { onQr: "handoff", reason: "operator pre-warm" });
  console.log(`   final URL: ${page.url()}`);
  console.log("✅ Logged in. Persistent profile saved to browser-data/.");
  await page.waitForTimeout(2_000);
});
