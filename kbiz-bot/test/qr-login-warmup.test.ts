// The batch warm-up's one decision, in isolation: may this poll ask a human to
// scan a QR, or is a failed handoff's cooldown still running?
//
// process-queue.ts owns the wiring (a module-level `lastQrFailAt`, an
// `ensureLoggedIn(page, { onQr: "handoff" })` before the item loop) but no
// policy — the policy is `shouldRequestQr`, which is why it is pure and tested
// here without a queue, a browser or a real clock.

import { describe, expect, it } from "bun:test";
import { QR_COOLDOWN_MS, shouldRequestQr } from "../src/lib/qr-login-core";

const T0 = 1_757_000_000_000; // an arbitrary fixed epoch — no real clock here

describe("shouldRequestQr", () => {
  it("asks when nothing has failed yet", () => {
    expect(shouldRequestQr(T0, null)).toBe(true);
    expect(shouldRequestQr(T0, undefined)).toBe(true);
  });

  it("stays quiet for the whole cooldown after a failed handoff", () => {
    expect(shouldRequestQr(T0, T0)).toBe(false);
    expect(shouldRequestQr(T0 + 30_000, T0)).toBe(false);
    expect(shouldRequestQr(T0 + QR_COOLDOWN_MS - 1, T0)).toBe(false);
  });

  it("asks again the moment the cooldown is up", () => {
    expect(shouldRequestQr(T0 + QR_COOLDOWN_MS, T0)).toBe(true);
    expect(shouldRequestQr(T0 + QR_COOLDOWN_MS + 1, T0)).toBe(true);
  });

  it("is 10 minutes — the interval the timeout Slack line promises", () => {
    expect(QR_COOLDOWN_MS).toBe(10 * 60_000);
  });

  it("takes an explicit cooldown so the value is never hard-coded twice", () => {
    expect(shouldRequestQr(T0 + 5_000, T0, 10_000)).toBe(false);
    expect(shouldRequestQr(T0 + 10_000, T0, 10_000)).toBe(true);
  });

  it("fails closed on a backwards clock and re-opens on a forwards one", () => {
    // A clock that went backwards reads as "the failure is still ahead of us"
    // — stay quiet, which is the harmless direction (work waits, nothing pays).
    expect(shouldRequestQr(T0 - 1_000, T0)).toBe(false);
    // … and a forwards jump past the window always re-opens it.
    expect(shouldRequestQr(T0 + 24 * 60 * 60_000, T0)).toBe(true);
  });
});
