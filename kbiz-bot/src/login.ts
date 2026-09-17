import { withSession, ensureLoggedIn } from "./lib/session";

// The DEV login. `onQr: "handoff"` because a human is, by definition, already
// here: K BIZ answers user/pass with a QR page (since June 2026), so this
// publishes the QR to KBIZ_QR_DIR, pings Slack with the link and waits up to
// 6.5 min for the scan.
//
// ⚠ NEVER RUN THIS AGAINST THE PROD PROFILE WHILE THE WATCHER IS UP.
// Since CR-2026-09-17 the watch container holds ONE persistent Chromium
// context for its whole lifetime (src/lib/session-keeper.ts). A second process
// opening `browser-data/` fights it for the profile lock, and a second K BIZ
// login kills the resident session the bot is keeping alive — which is exactly
// the outage this CR exists to prevent. In production the operator starts a
// login by pressing "เข้าสู่ระบบ K BIZ" on the QR page instead; the bot claims
// the request and runs the same handoff on the session it already owns.
await withSession(async (_ctx, page) => {
  await ensureLoggedIn(page, { onQr: "handoff", reason: "operator pre-warm" });
  console.log(`   final URL: ${page.url()}`);
  console.log("✅ Logged in. Persistent profile saved to browser-data/.");
  await page.waitForTimeout(2_000);
});
