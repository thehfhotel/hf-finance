// The batch warm-up, after CR-2026-09-17 (resident session).
//
// This file used to test `shouldAttemptLogin` — the 10-minute cooldown that
// rate-limited the bot's own decision to ask a human for a QR scan. There is
// no such decision any more: the K BIZ app cannot scan a QR from a saved
// picture, so a scan always needs a second screen, and an unsolicited QR is
// usually one nobody can use. A login now starts ONLY when an operator presses
// the button on the QR page.
//
// What is left to prove is therefore an ABSENCE, and absences are exactly what
// a passing suite stops noticing: the queue path must never again pass
// `onQr: "handoff"`, and no cooldown may creep back in to "protect" an ask
// that no longer exists. process-queue.ts is not importable here (it pulls
// playwright for real; root CI runs `bun test` before kbiz-bot/node_modules
// exists), so it is read as TEXT, exactly like arm-gate.test.ts's wiring block.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(at(rel), "utf8");

const queueSrc = read("../src/process-queue.ts");
const coreSrc = read("../src/lib/qr-login-core.ts");

describe("the queue never asks for a QR scan on its own", () => {
  it("runs the warm-up under the DEFAULT refuse policy, with no options at all", () => {
    // `ensureLoggedIn(page)` with no second argument IS the refuse policy
    // (session.ts's LoginOptions defaults to `onQr: "refuse"`), which throws
    // QrLoginRequiredError the instant the bank shows `loginQR.do` instead of
    // publishing a code nobody asked for.
    expect(queueSrc).toContain("await ensureLoggedIn(page);");
    expect(queueSrc).not.toMatch(/onQr:\s*"handoff"/);
  });

  it("warms up BEFORE the item loop, so an absent session costs no item", () => {
    const warmUp = queueSrc.indexOf("await ensureLoggedIn(page);");
    const loop = queueSrc.indexOf("for (const req of approved) {");
    expect(warmUp).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(warmUp);
    // …and it returns the batch untouched rather than claiming anything.
    const block = queueSrc.slice(warmUp, loop);
    expect(block).toContain("onSessionDead");
    expect(block).toContain("return approved.length;");
    expect(block).not.toContain('status: "running"');
  });

  it("masks the note it hands over — session.json is served on a web page", () => {
    // Every other note that reaches session.json goes through `maskedNote`.
    // This one is the easiest to forget, because the console line right beside
    // it is masked already: a raw Playwright error carries a multi-line call
    // log and, since June 2026, `loginQR.do?cmd=<session token>`.
    const warmUp = queueSrc.indexOf("await ensureLoggedIn(page);");
    const loop = queueSrc.indexOf("for (const req of approved) {");
    const block = queueSrc.slice(warmUp, loop);
    expect(block).toMatch(/onSessionDead\?\.\(\{[\s\S]*?maskedNote\(/);
    // …and it says WHICH kind of failure it was, so a bank blip does not get
    // booked as a session death (session-keeper-core.ts counts those).
    expect(block).toContain("isSessionDeathError");
  });

  it("hands the dead session to the keeper instead of Slacking about it itself", () => {
    // One voice per death: the keeper posts "เซสชัน K BIZ หมดอายุแล้ว" exactly
    // once and nudges while work waits. A second line from the batch would
    // re-ping every 30 s for as long as the session stays down.
    const warmUp = queueSrc.indexOf("await ensureLoggedIn(page);");
    const loop = queueSrc.indexOf("for (const req of approved) {");
    expect(queueSrc.slice(warmUp, loop)).not.toContain("notifySlack");
  });

  it("takes the keeper's page rather than opening a browser of its own", () => {
    expect(queueSrc).toMatch(/async function processBatch\(\s*\n?\s*page: Page,/);
    // Not imported, never called: the resident keeper owns the context. (The
    // word still appears in one comment, about the settlement check's own
    // fallback path — hence a call/import check rather than a bare substring.)
    expect(queueSrc).not.toMatch(/withSession\s*\(/);
    expect(queueSrc).not.toMatch(/import\s*\{[^}]*withSession/);
  });
});

describe("the removed cooldown stays removed", () => {
  it("has no shouldAttemptLogin / QR_COOLDOWN_MS anywhere on the login path", () => {
    for (const src of [coreSrc, queueSrc]) {
      expect(src).not.toContain("shouldAttemptLogin");
      expect(src).not.toContain("QR_COOLDOWN_MS");
    }
    expect(queueSrc).not.toContain("lastLoginFailAt");
  });

  it("promises a button, not a retry, when nobody scans", () => {
    // The contract's one edited line: the bot will NOT ask again in 10 minutes,
    // because the bot never asks at all. A stale promise here is how an
    // operator ends up waiting for a QR that is never coming.
    expect(coreSrc).toContain("กดปุ่มใหม่เมื่อพร้อม");
    expect(coreSrc).not.toContain("จะขอใหม่ใน 10 นาที");
  });
});
