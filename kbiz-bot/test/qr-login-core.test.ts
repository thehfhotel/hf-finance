// Pure-function + virtual-clock coverage for the K BIZ QR-login handoff
// (CR-2026-09-17). No browser, no real timers, no filesystem: the full 6.5-min
// deadline below runs in this file's own wall time in milliseconds.
//
// Run with `bun test` — from kbiz-bot/ AND from the repo root, where
// kbiz-bot's node_modules do not exist. Nothing here may reach playwright.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import {
  decodeQrDataUri,
  isQrLoginUrl,
  maskQrMessage,
  QR_HANDOFF_TIMEOUT_MS,
  QR_POLL_MS,
  QR_WINDOW_MS,
  QrLoginTimeoutError,
  qrSuccessMessage,
  qrTimeoutMessage,
  qrWaitingMessage,
  runQrHandoff,
} from "../src/lib/qr-login-core";
import {
  PNG_1PX_B64,
  pngDataUri,
  STUB_DASHBOARD_URL,
  STUB_LOGIN_URL,
  stubQrView,
} from "./support/stub-qr-view";

const REASON = "2 approved item(s)";
const PAGE_URL = "https://payroll.thehfhotel.org/kbiz/login-qr";
const run = (view: Parameters<typeof runQrHandoff>[0]) => runQrHandoff(view, { reason: REASON, pageUrl: PAGE_URL });

// A second, DIFFERENT PNG — the bank rotates the code, and "fresh" is keyed on
// the data URI changing, so the two fixtures must not be equal.
const PNG_1PX_B64_ALT =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("isQrLoginUrl", () => {
  it("recognises the live loginQR.do landing (with and without its query string)", () => {
    expect(isQrLoginUrl("https://kbiz.kasikornbank.com/authen/loginQR.do?cmd=abc123")).toBe(true);
    expect(isQrLoginUrl("https://kbiz.kasikornbank.com/authen/loginQR.do")).toBe(true);
  });

  it("does not fire on the credentials form or on a menu page", () => {
    expect(isQrLoginUrl(STUB_LOGIN_URL)).toBe(false);
    expect(isQrLoginUrl(STUB_DASHBOARD_URL)).toBe(false);
  });
});

describe("decodeQrDataUri", () => {
  it("decodes a data:image/png;base64 URI to the PNG bytes", () => {
    const bytes = decodeQrDataUri(pngDataUri());
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.length).toBe(Buffer.from(PNG_1PX_B64, "base64").length);
  });

  it("refuses a non-PNG media type", () => {
    expect(() => decodeQrDataUri(`data:image/gif;base64,${PNG_1PX_B64}`)).toThrow(/not a data:image\/png/);
  });

  it("refuses a plain URL (an <img src> that is not a data URI at all)", () => {
    expect(() => decodeQrDataUri("/authen/qrcode.png?cmd=abc")).toThrow(/not a data:image\/png/);
  });

  it("refuses malformed base64", () => {
    expect(() => decodeQrDataUri("data:image/png;base64,!!!!")).toThrow(/not valid base64/);
    expect(() => decodeQrDataUri("data:image/png;base64,")).toThrow(/not valid base64/);
  });

  it("tolerates whitespace inside the payload (markup may wrap the attribute)", () => {
    // `getAttribute` hands back the raw attribute text, newlines and all. Such
    // a URI decodes in every browser, so rejecting it would abort the handoff
    // over formatting — the PNG-magic check below still guards what is written.
    const wrapped = `data:image/png;base64,${PNG_1PX_B64.slice(0, 20)}\n  ${PNG_1PX_B64.slice(20)}`;
    expect(Array.from(decodeQrDataUri(wrapped))).toEqual(Array.from(decodeQrDataUri(pngDataUri())));
  });

  it("refuses well-formed base64 whose bytes are not a PNG", () => {
    // Valid base64, decodes cleanly, wrong magic — the case a silent
    // Buffer.from would have written to disk as `current.png`.
    expect(() => decodeQrDataUri("data:image/png;base64,aGVsbG8hISE=")).toThrow(/not a PNG/);
  });
});

describe("Slack text (contract-pinned)", () => {
  it("asks for a scan with the reason, the QR number and the page link", () => {
    expect(qrWaitingMessage({ reason: REASON, attempt: 1, pageUrl: PAGE_URL })).toBe(
      ":lock: kbiz-bot: K BIZ ต้องสแกน QR เพื่อเข้าสู่ระบบ (2 approved item(s), QR #1) — " +
        "เปิด https://payroll.thehfhotel.org/kbiz/login-qr บนคอมพิวเตอร์ แล้วสแกนด้วยแอป K BIZ ภายใน 5 นาที",
    );
  });

  it("confirms the login and reports the timeout", () => {
    expect(qrSuccessMessage(REASON)).toBe(":white_check_mark: kbiz-bot: เข้าสู่ระบบ K BIZ แล้ว (2 approved item(s))");
    expect(qrTimeoutMessage()).toBe(
      ":hourglass: kbiz-bot: ไม่มีการสแกนใน 6.5 นาที — งานยังรออยู่ จะขอใหม่ใน 10 นาที",
    );
  });
});

describe("maskQrMessage", () => {
  it("drops query strings and long digit runs", () => {
    expect(maskQrMessage("bounced to /authen/loginQR.do?cmd=SECRETTOKEN while waiting")).toBe(
      "bounced to /authen/loginQR.do while waiting",
    );
    expect(maskQrMessage("could not write 1234567890")).toBe("could not write ******");
  });
});

describe("runQrHandoff — first QR", () => {
  it("writes the PNG, publishes a `waiting` state and pings Slack once", async () => {
    const view = stubQrView([
      { atMs: 0, qrDataUri: pngDataUri() },
      { atMs: 4 * QR_POLL_MS, url: STUB_DASHBOARD_URL, qrDataUri: null },
    ]);
    await run(view);

    expect(view.pngWrites().length).toBe(1);
    const waiting = view.states()[0]!;
    expect(waiting.status).toBe("waiting");
    expect(waiting.attempt).toBe(1);
    expect(waiting.reason).toBe(REASON);
    expect(waiting.capturedAt).not.toBeNull();
    // expiresAt is capturedAt + the bank's own 5:55 countdown.
    expect(Date.parse(waiting.expiresAt!) - Date.parse(waiting.capturedAt!)).toBe(QR_WINDOW_MS);
    expect(view.notifications()[0]).toBe(qrWaitingMessage({ reason: REASON, attempt: 1, pageUrl: PAGE_URL }));
  });

  it("publishes the QR at t=0, not one poll later (the human's 5:55 is already running)", async () => {
    const view = stubQrView([
      { atMs: 0, qrDataUri: pngDataUri() },
      { atMs: 2 * QR_POLL_MS, url: STUB_DASHBOARD_URL, qrDataUri: null },
    ]);
    await run(view);
    // `capturedAt` IS the publish moment — the state file and the PNG are
    // written in the same breath, and the operator page counts down from it.
    expect(Date.parse(view.states()[0]!.capturedAt!)).toBe(0);
  });
});

describe("runQrHandoff — a rotated QR", () => {
  it("rewrites both files, increments `attempt`, and rate-limits Slack to one ping a minute", async () => {
    const view = stubQrView([
      { atMs: 0, qrDataUri: pngDataUri() },
      { atMs: 30_000, qrDataUri: pngDataUri(PNG_1PX_B64_ALT) },
      { atMs: 120_000, url: STUB_DASHBOARD_URL, qrDataUri: null },
    ]);
    await run(view);

    expect(view.pngWrites().length).toBe(2);
    const waiting = view.states().filter((s) => s.status === "waiting");
    expect(waiting.map((s) => s.attempt)).toEqual([1, 2]);
    // 30 s after the first ping — the second QR is published but stays quiet.
    expect(view.notifications().filter((n) => n.includes("ต้องสแกน QR")).length).toBe(1);
  });

  it("pings again once 60 s have passed since the last ping", async () => {
    const view = stubQrView([
      { atMs: 0, qrDataUri: pngDataUri() },
      { atMs: 60_000, qrDataUri: pngDataUri(PNG_1PX_B64_ALT) },
      { atMs: 120_000, url: STUB_DASHBOARD_URL, qrDataUri: null },
    ]);
    await run(view);

    const scanPings = view.notifications().filter((n) => n.includes("ต้องสแกน QR"));
    expect(scanPings.length).toBe(2);
    expect(scanPings[1]).toContain("QR #2");
  });

  it("does not republish the same QR on every poll", async () => {
    const view = stubQrView([
      { atMs: 0, qrDataUri: pngDataUri() },
      { atMs: 20_000, url: STUB_DASHBOARD_URL, qrDataUri: null },
    ]);
    await run(view);
    expect(view.pngWrites().length).toBe(1);
    expect(view.states().filter((s) => s.status === "waiting").length).toBe(1);
  });
});

describe("runQrHandoff — the scan lands", () => {
  it("confirms the dashboard, files `ok`, removes the PNG and says so in Slack", async () => {
    const view = stubQrView([
      { atMs: 0, qrDataUri: pngDataUri() },
      { atMs: 6_000, url: STUB_DASHBOARD_URL, qrDataUri: null },
    ]);
    await run(view);

    const last = view.states().at(-1)!;
    expect(last.status).toBe("ok");
    expect(last.capturedAt).toBeNull();
    expect(last.expiresAt).toBeNull();
    expect(view.pngRemovals()).toBeGreaterThanOrEqual(1);
    expect(view.dashboardChecks()).toBe(1);
    expect(view.notifications().at(-1)).toBe(qrSuccessMessage(REASON));
  });

  it("never trusts the redirect alone — an unconfirmed dashboard keeps waiting", async () => {
    // The URL leaves /authen but the dashboard does not render (KBIZ's async
    // session check bounces us). No `ok` may be published on that.
    const view = stubQrView(
      [
        { atMs: 0, qrDataUri: pngDataUri() },
        { atMs: 4_000, url: STUB_DASHBOARD_URL, qrDataUri: null },
      ],
      { confirmDashboard: false },
    );
    await expect(run(view)).rejects.toBeInstanceOf(QrLoginTimeoutError);
    expect(view.states().some((s) => s.status === "ok")).toBe(false);
    expect(view.dashboardChecks()).toBeGreaterThan(1);
  });
});

describe("runQrHandoff — nothing is scanned", () => {
  it("files `expired` at the deadline and throws QrLoginTimeoutError", async () => {
    const view = stubQrView([{ atMs: 0, qrDataUri: pngDataUri() }]);
    await expect(run(view)).rejects.toBeInstanceOf(QrLoginTimeoutError);

    const last = view.states().at(-1)!;
    expect(last.status).toBe("expired");
    expect(view.pngRemovals()).toBeGreaterThanOrEqual(1);
    expect(view.elapsed()).toBeGreaterThanOrEqual(QR_HANDOFF_TIMEOUT_MS);
    // The timeout Slack line is the CALLER's (process-queue knows the 10-min
    // cooldown it is about to start); the core only publishes state.
    expect(view.notifications().filter((n) => n.includes("ไม่มีการสแกน")).length).toBe(0);
  });

  it("files `expired` the moment the bank drops back to the credentials form", async () => {
    const view = stubQrView([
      { atMs: 0, qrDataUri: pngDataUri() },
      { atMs: 10_000, url: STUB_LOGIN_URL, qrDataUri: null, loginFormVisible: true },
    ]);
    await expect(run(view)).rejects.toBeInstanceOf(QrLoginTimeoutError);

    expect(view.states().at(-1)!.status).toBe("expired");
    // Bailed out at ~10 s, nowhere near the 6.5-min deadline.
    expect(view.elapsed()).toBeLessThan(20_000);
    expect(view.pngRemovals()).toBeGreaterThanOrEqual(1);
  });
});

describe("runQrHandoff — a credentials form that appears WITH a QR on screen", () => {
  it("publishes the code instead of bailing out (the CR's precedence: QR before form)", async () => {
    // The live probe recorded `img.qrcode` and the countdown; it did NOT prove
    // the absence of a `#userName` in loginQR.do's DOM. If the bank ever keeps
    // one visible there, checking the form first would file `expired` on the
    // first poll and no QR would ever reach the operator page.
    const view = stubQrView([
      { atMs: 0, qrDataUri: pngDataUri(), loginFormVisible: true },
      { atMs: 4 * QR_POLL_MS, url: STUB_DASHBOARD_URL, qrDataUri: null },
    ]);
    await run(view);

    expect(view.pngWrites().length).toBe(1);
    expect(view.states()[0]!.status).toBe("waiting");
    expect(view.states().at(-1)!.status).toBe("ok");
  });
});

describe("runQrHandoff — an interrupted handoff", () => {
  it("takes current.png down when an unexpected error escapes the loop", async () => {
    // `current.png` on disk is the claim "a live QR is waiting". A throw the
    // state machine does not own (a full disk, a webhook that rejects) must
    // not leave that claim standing on the Cloudflare-gated page.
    const view = stubQrView([{ atMs: 0, qrDataUri: pngDataUri() }]);
    const realNotify = view.notify;
    view.notify = async (text: string) => {
      await realNotify(text);
      throw new Error("ENOSPC: webhook spool full");
    };
    await expect(run(view)).rejects.toThrow(/ENOSPC/);

    expect(view.pngWrites().length).toBe(1);
    expect(view.pngRemovals()).toBeGreaterThanOrEqual(1);
  });
});

describe("runQrHandoff — an unreadable QR", () => {
  it("files `error` and throws rather than publishing an unverified image", async () => {
    const view = stubQrView([{ atMs: 0, qrDataUri: `data:image/gif;base64,${PNG_1PX_B64}` }]);
    await expect(run(view)).rejects.toThrow(/QR login handoff failed/);

    expect(view.pngWrites().length).toBe(0);
    const last = view.states().at(-1)!;
    expect(last.status).toBe("error");
    expect(last.message).toContain("Could not read the QR image");
    expect(view.pngRemovals()).toBeGreaterThanOrEqual(1);
  });

  it("treats a malformed data URI the same way", async () => {
    const view = stubQrView([{ atMs: 0, qrDataUri: "data:image/png;base64,!!!!" }]);
    await expect(run(view)).rejects.toThrow(/QR login handoff failed/);
    expect(view.states().at(-1)!.status).toBe("error");
    expect(view.pngWrites().length).toBe(0);
  });

  it("does not let a timeout error be mistaken for an unreadable QR", async () => {
    // process-queue keys the 10-min cooldown on QrLoginTimeoutError alone; an
    // `error` must surface as an ordinary batch error instead.
    const view = stubQrView([{ atMs: 0, qrDataUri: "data:image/png;base64,!!!!" }]);
    const thrown = await run(view).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(QrLoginTimeoutError);
  });
});

// Same guard the other pure modules carry: read the source as TEXT so it fails
// in the root-CI context (no kbiz-bot/node_modules) rather than at import time.
const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe("no playwright import (root CI runs bun test before kbiz-bot's node_modules exist)", () => {
  it("qr-login-core.ts imports nothing from playwright", () => {
    expect(readFileSync(at("../src/lib/qr-login-core.ts"), "utf8")).not.toMatch(/from\s+["']playwright["']/);
  });

  it("qr-login-files.ts imports nothing from playwright", () => {
    expect(readFileSync(at("../src/lib/qr-login-files.ts"), "utf8")).not.toMatch(/from\s+["']playwright["']/);
  });

  it("test/support/stub-qr-view.ts imports nothing from playwright", () => {
    expect(readFileSync(at("support/stub-qr-view.ts"), "utf8")).not.toMatch(/from\s+["']playwright["']/);
  });

  it("test/support/frame-clock.ts imports nothing from playwright", () => {
    expect(readFileSync(at("support/frame-clock.ts"), "utf8")).not.toMatch(/from\s+["']playwright["']/);
  });
});
