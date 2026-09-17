// The QR publication on disk. Everything here runs against a real temp
// directory (fs is the whole point of qr-login-files.ts) but no browser, no
// network and no queue — `bun test` from the repo root runs this file BEFORE
// kbiz-bot/node_modules exists, so nothing it touches may reach playwright.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  claimLoginRequest,
  clearStaleQrPublication,
  LOGIN_REQUEST_CLAIMED_FILE,
  LOGIN_REQUEST_FILE,
  QR_PNG_FILE,
  QR_SESSION_FILE,
  QR_STATE_FILE,
  readLoginRequest,
  removeQrPng,
  writeQrPng,
  writeQrState,
  writeSessionFile,
} from "../src/lib/qr-login-files";
import { terminalState, type QrLoginState } from "../src/lib/qr-login-core";
import { sessionFileFrom, initialKeeperState, applyCheckResult, setPending } from "../src/lib/session-keeper-core";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kbiz-qr-login-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const pngPath = () => join(dir, QR_PNG_FILE);
const statePath = () => join(dir, QR_STATE_FILE);
const readState = (): QrLoginState => JSON.parse(readFileSync(statePath(), "utf8")) as QrLoginState;

const waiting = (over: Partial<QrLoginState> = {}): QrLoginState => ({
  status: "waiting",
  reason: "2 approved item(s)",
  attempt: 1,
  capturedAt: "2026-09-17T01:00:00.000Z",
  expiresAt: "2026-09-17T01:05:55.000Z",
  updatedAt: "2026-09-17T01:00:00.000Z",
  message: "QR #1 ready — scan it with the K BIZ app",
  ...over,
});

describe("writeQrPng / writeQrState", () => {
  it("writes both files atomically, into a directory that need not exist yet", () => {
    const nested = join(dir, "does", "not", "exist");
    writeQrPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), nested);
    writeQrState(waiting(), nested);

    expect(Array.from(readFileSync(join(nested, QR_PNG_FILE)))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(JSON.parse(readFileSync(join(nested, QR_STATE_FILE), "utf8"))).toEqual(waiting());
    // payroll-form polls these every 5 s — no `.tmp` may survive the rename,
    // and no reader may ever catch a half-written file.
    expect(existsSync(join(nested, `${QR_PNG_FILE}.tmp`))).toBe(false);
    expect(existsSync(join(nested, `${QR_STATE_FILE}.tmp`))).toBe(false);
  });

  it("ends the state file with a newline, and rewrites in place", () => {
    writeQrState(waiting(), dir);
    expect(readFileSync(statePath(), "utf8").endsWith("}\n")).toBe(true);
    writeQrState(waiting({ attempt: 2 }), dir);
    expect(readState().attempt).toBe(2);
  });
});

describe("removeQrPng", () => {
  it("removes a published PNG", () => {
    writeQrPng(new Uint8Array([1, 2, 3]), dir);
    removeQrPng(dir);
    expect(existsSync(pngPath())).toBe(false);
  });

  it("is a no-op when there is nothing to remove", () => {
    // The PNG is absent in every non-`waiting` state, so "already gone" is the
    // normal case, not an error — it must never throw.
    expect(() => removeQrPng(dir)).not.toThrow();
    expect(() => removeQrPng(join(dir, "no", "such", "dir"))).not.toThrow();
  });
});

describe("clearStaleQrPublication", () => {
  it("settles a leftover `waiting` state to `expired` and takes the PNG down", () => {
    writeQrPng(new Uint8Array([0x89, 0x50]), dir);
    writeQrState(waiting(), dir);

    clearStaleQrPublication(dir);

    const state = readState();
    expect(state.status).toBe("expired");
    expect(state.message).toBe("Interrupted before any scan");
    // The reason survives (the page still says what the dead handoff was for)
    // but the live-looking countdown does not.
    expect(state.reason).toBe("2 approved item(s)");
    expect(state.attempt).toBe(1);
    expect(state.capturedAt).toBeNull();
    expect(state.expiresAt).toBeNull();
    expect(existsSync(pngPath())).toBe(false);
  });

  it("leaves a non-`waiting` state exactly as it found it", () => {
    const settled = terminalState({
      status: "ok",
      reason: "operator pre-warm",
      attempt: 2,
      atMs: Date.parse("2026-09-17T01:02:03.000Z"),
      message: "Logged in",
    });
    writeQrState(settled, dir);

    clearStaleQrPublication(dir);

    expect(readState()).toEqual(settled);
  });

  it("does nothing, and never throws, when there is no state file at all", () => {
    expect(() => clearStaleQrPublication(dir)).not.toThrow();
    expect(existsSync(statePath())).toBe(false);
  });

  it("leaves an unreadable state file alone rather than guessing", () => {
    writeFileSync(statePath(), "{ not json");
    writeQrPng(new Uint8Array([9]), dir);

    expect(() => clearStaleQrPublication(dir)).not.toThrow();
    // The PNG still goes (it is the claim we can disprove); the file we cannot
    // parse is not rewritten from a guess.
    expect(existsSync(pngPath())).toBe(false);
    expect(readFileSync(statePath(), "utf8")).toBe("{ not json");
  });
});

// ── The resident session record (CR-2026-09-17) ───────────────────────────

describe("writeSessionFile", () => {
  const sessionPath = () => join(dir, QR_SESSION_FILE);
  const readSession = () => JSON.parse(readFileSync(sessionPath(), "utf8"));

  it("publishes the keeper's record atomically, with the contract's fields", () => {
    const alive = applyCheckResult(initialKeeperState(), {
      nowMs: Date.parse("2026-09-17T01:00:00.000Z"),
      alive: true,
      note: "keepalive ok",
    }).state;
    writeSessionFile(sessionFileFrom(setPending(alive, 2)), dir);

    expect(readSession()).toEqual({
      alive: true,
      since: "2026-09-17T01:00:00.000Z",
      checkedAt: "2026-09-17T01:00:00.000Z",
      endedAt: null,
      lastLifetimeMs: null,
      pending: 2,
      note: "keepalive ok",
    });
    // payroll-form polls this every 5 s and offers the login button when it
    // reads "no session" — a half-written object must never be visible.
    expect(existsSync(join(dir, `${QR_SESSION_FILE}.tmp`))).toBe(false);
    expect(readFileSync(sessionPath(), "utf8").endsWith("}\n")).toBe(true);
  });

  it("rewrites in place, and creates the directory if it is not there yet", () => {
    const nested = join(dir, "does", "not", "exist");
    writeSessionFile(sessionFileFrom(initialKeeperState()), nested);
    expect(JSON.parse(readFileSync(join(nested, QR_SESSION_FILE), "utf8")).alive).toBe(false);

    writeSessionFile(sessionFileFrom(setPending(initialKeeperState(), 4)), nested);
    expect(JSON.parse(readFileSync(join(nested, QR_SESSION_FILE), "utf8")).pending).toBe(4);
  });
});

describe("readLoginRequest / claimLoginRequest", () => {
  const requestPath = () => join(dir, LOGIN_REQUEST_FILE);
  const claimedPath = () => join(dir, LOGIN_REQUEST_CLAIMED_FILE);
  const write = (body: string) => writeFileSync(requestPath(), body);

  it("reads what payroll-form writes", () => {
    write(JSON.stringify({ requestedAt: "2026-09-17T01:00:00.000Z", by: "operator@example.com" }));
    expect(readLoginRequest(dir)).toEqual({
      requestedAt: "2026-09-17T01:00:00.000Z",
      by: "operator@example.com",
    });
  });

  it("is null when nobody has pressed the button", () => {
    expect(readLoginRequest(dir)).toBeNull();
    expect(readLoginRequest(join(dir, "no", "such", "dir"))).toBeNull();
  });

  it("falls back to 'unknown' when Cloudflare gave payroll-form no email", () => {
    write(JSON.stringify({ requestedAt: "2026-09-17T01:00:00.000Z" }));
    expect(readLoginRequest(dir)!.by).toBe("unknown");
  });

  it("flattens a header that tries to carry newlines into the Slack line", () => {
    write(JSON.stringify({ requestedAt: "2026-09-17T01:00:00.000Z", by: "a\nb\tc " }));
    expect(readLoginRequest(dir)!.by).toBe("a b c");
    write(JSON.stringify({ requestedAt: "2026-09-17T01:00:00.000Z", by: "x".repeat(400) }));
    expect(readLoginRequest(dir)!.by.length).toBe(120);
  });

  it("still reports a MALFORMED request, so it can be claimed away", () => {
    // The file's presence IS the ask. Returning null here would leave it on
    // disk forever, with the page stuck on "กำลังเตรียม QR…" and the bot
    // ignoring it — only the claim removes it.
    write("{ not json");
    expect(readLoginRequest(dir)).toEqual({ requestedAt: "", by: "unknown" });
    expect(claimLoginRequest(dir)).toBe(true);
    expect(readLoginRequest(dir)).toBeNull();
  });

  it("claims by renaming — one file, never both, never neither", () => {
    write(JSON.stringify({ requestedAt: "2026-09-17T01:00:00.000Z", by: "operator@example.com" }));
    expect(claimLoginRequest(dir)).toBe(true);

    expect(existsSync(requestPath())).toBe(false);
    expect(JSON.parse(readFileSync(claimedPath(), "utf8")).by).toBe("operator@example.com");
    // …and the claim is what makes a second tick leave the bank alone.
    expect(readLoginRequest(dir)).toBeNull();
    expect(claimLoginRequest(dir)).toBe(false);
  });

  it("overwrites a stale claimed file rather than refusing the new request", () => {
    writeFileSync(claimedPath(), JSON.stringify({ requestedAt: "2026-09-01T00:00:00.000Z", by: "ตัวอย่าง" }));
    write(JSON.stringify({ requestedAt: "2026-09-17T02:00:00.000Z", by: "operator@example.com" }));

    expect(claimLoginRequest(dir)).toBe(true);
    expect(JSON.parse(readFileSync(claimedPath(), "utf8")).requestedAt).toBe("2026-09-17T02:00:00.000Z");
  });

  it("never throws when there is nothing to claim", () => {
    expect(claimLoginRequest(dir)).toBe(false);
    expect(claimLoginRequest(join(dir, "no", "such", "dir"))).toBe(false);
  });
});
